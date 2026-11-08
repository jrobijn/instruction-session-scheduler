package server

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	mrand "math/rand/v2"
	"net/http"
	"strconv"
	"strings"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

const terminalStatuses = "('declined', 'expired', 'invalidated', 'cancelled', 'admin_cancelled')"

// invitationDetails is an invitation with the session, student, timeslot and discipline
// details the invitation actions need. Load it with findInvitation(s).
type invitationDetails struct {
	ID             int64   `db:"id"`
	SessionID      int64   `db:"session_id"`
	StudentID      int64   `db:"student_id"`
	TimeslotID     int64   `db:"timeslot_id"`
	SlotID         int64   `db:"slot_id"`
	GroupID        *int64  `db:"group_id"`
	DisciplineID   *int64  `db:"discipline_id"`
	Token          string  `db:"token"`
	Status         string  `db:"status"`
	InvitedAt      string  `db:"invited_at"`
	EmailSent      int64   `db:"email_sent"`
	SessionDate    string  `db:"session_date"`
	SessionStatus  string  `db:"session_status"`
	SessionNotes   *string `db:"session_notes"`
	StudentName    string  `db:"student_name"`
	StudentEmail   string  `db:"student_email"`
	StartTime      string  `db:"start_time"`
	DisciplineName *string `db:"discipline_name"`
}

// findInvitations loads the invitations matching where, a WHERE clause (plus anything that
// may follow it) over inv (invitations), ts (training_sessions), s (students), tslot
// (timeslots) and d (disciplines).
func (s *Server) findInvitations(where string, args ...any) ([]invitationDetails, error) {
	return db.Many[invitationDetails](s.db, `
		SELECT inv.id, inv.session_id, inv.student_id, inv.timeslot_id, inv.slot_id, inv.group_id, inv.discipline_id,
			inv.token, inv.status, inv.invited_at, inv.email_sent,
			ts.date AS session_date, ts.status AS session_status, ts.notes AS session_notes,
			s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
			tslot.start_time, d.name AS discipline_name
		FROM invitations inv
		JOIN training_sessions ts ON ts.id = inv.session_id
		JOIN students s ON s.id = inv.student_id
		JOIN timeslots tslot ON tslot.id = inv.timeslot_id
		LEFT JOIN disciplines d ON d.id = inv.discipline_id
		`+where, args...)
}

// findInvitation is findInvitations for a single invitation; found is false if none matches.
func (s *Server) findInvitation(where string, args ...any) (inv invitationDetails, found bool, err error) {
	invs, err := s.findInvitations(where, args...)
	if err != nil || len(invs) == 0 {
		return inv, false, err
	}
	return invs[0], true, nil
}

func (i invitationDetails) timing() invitationTiming {
	return invitationTiming{Status: i.Status, InvitedAt: i.InvitedAt, SessionDate: i.SessionDate, StartTime: i.StartTime}
}

// vacated describes the spot this invitation leaves open, for findAndInviteReplacement.
func (i invitationDetails) vacated() vacatedSpot {
	return vacatedSpot{
		SessionID: i.SessionID, SessionDate: i.SessionDate, TimeslotID: i.TimeslotID, SlotID: i.SlotID,
		GroupID: i.GroupID, StudentID: i.StudentID, Status: i.Status,
	}
}

func (s *Server) invitationRoutes() {
	s.publicRoute("GET /api/invitations/{token}", s.handleGetInvitation)
	s.publicRoute("POST /api/invitations/{token}/confirm", s.handleConfirmInvitation)
	s.publicRoute("POST /api/invitations/{token}/cancel", s.handleCancelInvitation)
	s.publicRoute("POST /api/invitations/{token}/decline", s.handleDeclineInvitation)
}

// --- shared helpers ----------------------------------------------------------------------

// newToken returns a random UUID v4, like crypto.randomUUID().
func newToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (s *Server) clubName() string    { return db.Setting(s.db, "club_name", "Sports Club") }
func (s *Server) emailLocale() string { return db.Setting(s.db, "email_locale", "en") }

// encodeJSON encodes v for storage (decision logs) without escaping <, > and &.
func encodeJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
	return strings.TrimSuffix(buf.String(), "\n")
}

func (s *Server) sessionCounts(sessionID int64) (map[string]any, error) {
	var total, confirmed int64
	err := s.db.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM invitations WHERE session_id = ?),
			(SELECT COUNT(*) FROM invitations WHERE session_id = ? AND status = 'confirmed')`,
		sessionID, sessionID).Scan(&total, &confirmed)
	return map[string]any{"session_id": sessionID, "invitation_count": total, "confirmed_count": confirmed}, err
}

func (s *Server) broadcastSessionCounts(sessionID int64) {
	counts, err := s.sessionCounts(sessionID)
	if err != nil {
		logf("session counts %d: %v", sessionID, err)
		return
	}
	s.hub.BroadcastSessionsList("session_counts_updated", counts)
}

func (s *Server) broadcastInvitation(token, status string) {
	s.hub.Broadcast("invitation:"+token, "invitation_updated", map[string]any{"status": status})
}

// sessionFull reports whether every instructor x timeslot spot of the session is confirmed.
func (s *Server) sessionFull(sessionID int64) (bool, error) {
	var timetableID *int64
	if err := s.db.QueryRow("SELECT timetable_id FROM training_sessions WHERE id = ?", sessionID).Scan(&timetableID); err != nil || timetableID == nil {
		return false, nil
	}
	var instructors, timeslots, confirmed int64
	if err := s.db.QueryRow("SELECT COUNT(*) FROM session_slots WHERE session_id = ? AND removed = 0", sessionID).Scan(&instructors); err != nil {
		return false, err
	}
	if err := s.db.QueryRow("SELECT COUNT(*) FROM timeslots WHERE timetable_id = ?", *timetableID).Scan(&timeslots); err != nil {
		return false, err
	}
	total := instructors * timeslots
	if total == 0 {
		return false, nil
	}
	if err := s.db.QueryRow("SELECT COUNT(*) FROM invitations WHERE session_id = ? AND status = 'confirmed'", sessionID).Scan(&confirmed); err != nil {
		return false, err
	}
	return confirmed >= total, nil
}

// nonEmpty returns nil for "", so the value encodes as null (like `value || null`).
func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// preferredDays lists the student's preferred days that are club days, for the decision log.
// It is nil (null in the log) when they cover every club day. Entries that are not day
// numbers are ignored.
func preferredDays(studentDays, clubDays string) []int {
	if studentDays == "" {
		return nil
	}
	club := map[int]bool{}
	for _, d := range strings.Split(clubDays, "|") {
		if n, err := strconv.Atoi(strings.TrimSpace(d)); err == nil {
			club[n] = true
		}
	}
	out := []int{}
	for _, d := range strings.Split(studentDays, "|") {
		if n, err := strconv.Atoi(strings.TrimSpace(d)); err == nil && club[n] {
			out = append(out, n)
		}
	}
	if len(out) >= len(club) {
		return nil
	}
	return out
}

func (s *Server) prefsByStudent(timetableID int64) (map[int64]map[int64]bool, error) {
	type preference struct {
		StudentID  int64 `db:"student_id"`
		TimeslotID int64 `db:"timeslot_id"`
	}
	preferences, err := db.Many[preference](s.db, "SELECT student_id, timeslot_id FROM student_preferred_timeslots WHERE timetable_id = ?", timetableID)
	if err != nil {
		return nil, err
	}
	out := map[int64]map[int64]bool{}
	for _, p := range preferences {
		if out[p.StudentID] == nil {
			out[p.StudentID] = map[int64]bool{}
		}
		out[p.StudentID][p.TimeslotID] = true
	}
	return out, nil
}

// preferredStartTimes lists the start times of the timeslots in prefs, in timeslot order.
// It is nil (null in a decision log) when there are no preferences.
func preferredStartTimes(prefs map[int64]bool, timeslots []Timeslot) []string {
	if len(prefs) == 0 {
		return nil
	}
	list := []string{}
	for _, t := range timeslots {
		if prefs[t.ID] {
			list = append(list, t.StartTime)
		}
	}
	return list
}

// --- replacement -------------------------------------------------------------------------

type replacementLog struct {
	Trigger              string   `json:"trigger"`
	LastTurnAt           *string  `json:"last_turn_at"`
	InviteNext           bool     `json:"invite_next"`
	CandidateRank        int      `json:"candidate_rank"`
	CandidatesConsidered int      `json:"candidates_considered"`
	GroupName            *string  `json:"group_name"`
	GroupColor           *string  `json:"group_color"`
	ReplacedStudent      *string  `json:"replaced_student"`
	ReplacementReason    string   `json:"replacement_reason"`
	SameGroupMatch       bool     `json:"same_group_match"`
	PreferredTimeslots   []string `json:"preferred_timeslots"`
	PreferredDays        []int    `json:"preferred_days"`
}

// vacatedSpot is an instructor x timeslot spot of a session that needs a new student.
type vacatedSpot struct {
	SessionID   int64
	SessionDate string
	TimeslotID  int64
	SlotID      int64
	GroupID     *int64 // group of the invitation that held the spot, if any
	StudentID   int64  // student who left the spot; 0 if unknown (only for the decision log)
	Status      string // why they left; "" if unknown (only for the decision log)
}

// Replacement is the student invited for a vacated spot.
type Replacement struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// findAndInviteReplacement invites the next student in line for a vacated spot. Returns nil
// when nobody is eligible.
func (s *Server) findAndInviteReplacement(vacated vacatedSpot) (*Replacement, error) {
	sessionID, sessionDate := vacated.SessionID, vacated.SessionDate

	var timetableID *int64
	s.db.QueryRow("SELECT timetable_id FROM training_sessions WHERE id = ?", sessionID).Scan(&timetableID)
	hasTimetable := timetableID != nil && *timetableID != 0

	timetableGroups := map[int64]bool{}
	percentageByGroup := map[int64]float64{}
	if hasTimetable {
		groups, err := s.timetableGroups(*timetableID)
		if err != nil {
			return nil, err
		}
		for _, g := range groups {
			timetableGroups[g.GroupID] = true
			percentageByGroup[g.GroupID] = float64(g.Percentage)
		}
	}

	disciplineGroupIDs, err := db.Many[int64](s.db, "SELECT DISTINCT dg.group_id FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id WHERE d.active = 1")
	if err != nil {
		return nil, err
	}
	discGroups := map[int64]bool{}
	for _, gid := range disciplineGroupIDs {
		discGroups[gid] = true
	}

	dow := "NaN"
	if d, ok := dayOfWeek(sessionDate); ok {
		dow = strconv.Itoa(d)
	}
	candidates, err := s.queueCandidates(`
		WHERE s.active = 1
			AND s.deleted_at IS NULL
			AND ('|' || s.preferred_days || '|') LIKE '%|' || ? || '|%'
			AND (s.cooldown_until IS NULL OR date(s.cooldown_until) <= ?)
			AND s.id NOT IN (SELECT student_id FROM invitations WHERE session_id = ?)
			AND s.id NOT IN (
				SELECT inv.student_id FROM invitations inv
				JOIN training_sessions ts ON ts.id = inv.session_id
				WHERE ts.date = ? AND inv.status NOT IN `+terminalStatuses+`
			)
		ORDER BY `+queue.OrderSQL+`, RANDOM()`, dow, sessionDate, sessionID, sessionDate)
	if err != nil {
		return nil, err
	}

	prefs := map[int64]map[int64]bool{}
	if hasTimetable {
		if prefs, err = s.prefsByStudent(*timetableID); err != nil {
			return nil, err
		}
	}
	// eligible reports whether the candidate can take this spot: their group is in the
	// timetable and has an active discipline, and they have no preference against the timeslot.
	eligible := func(c candidate) bool {
		p := prefs[c.ID]
		prefersTimeslot := len(p) == 0 || p[vacated.TimeslotID]
		return prefersTimeslot && c.GroupID != 0 && timetableGroups[c.GroupID] && discGroups[c.GroupID]
	}

	hasOriginal := vacated.GroupID != nil && *vacated.GroupID != 0
	var replacement *candidate
	replacementGroup := vacated.GroupID
	sameGroupMatch := false
	candidateRank, candidatesConsidered := 0, len(candidates)

	// First pass: a replacement from the same group as the original invitation.
	for i, c := range candidates {
		if !eligible(c) {
			continue
		}
		candidateRank++
		if !hasOriginal || c.GroupID == *vacated.GroupID {
			replacement, replacementGroup, sameGroupMatch = &candidates[i], &candidates[i].GroupID, true
			break
		}
	}

	// Second pass: any timetable group, picked at random weighted by its percentage; then
	// the first candidate in that group's queue.
	if replacement == nil && hasOriginal && len(timetableGroups) > 0 {
		var groupOrder []int64
		byGroup := map[int64][]candidate{}
		for _, c := range candidates {
			if !eligible(c) {
				continue
			}
			if _, seen := byGroup[c.GroupID]; !seen {
				groupOrder = append(groupOrder, c.GroupID)
			}
			byGroup[c.GroupID] = append(byGroup[c.GroupID], c)
		}
		if len(groupOrder) > 0 {
			picked := queue.WeightedPickGroup(groupOrder, percentageByGroup, mrand.Float64)
			q := byGroup[picked]
			replacement, replacementGroup, sameGroupMatch = &q[0], &picked, false
			candidateRank, candidatesConsidered = 1, len(q)
		}
	}

	if replacement == nil {
		return nil, nil
	}

	var replacedName, groupName, groupColor string
	s.db.QueryRow("SELECT first_name || ' ' || last_name FROM students WHERE id = ?", vacated.StudentID).Scan(&replacedName)
	if replacementGroup != nil && *replacementGroup != 0 {
		s.db.QueryRow("SELECT name, color FROM groups WHERE id = ?", *replacementGroup).Scan(&groupName, &groupColor)
	}

	var preferredTimeslots []string
	if p := prefs[replacement.ID]; len(p) > 0 && hasTimetable {
		slots, err := s.timetableTimeslots(*timetableID)
		if err != nil {
			return nil, err
		}
		preferredTimeslots = preferredStartTimes(p, slots)
	}

	reason := "vacated"
	if vacated.Status != "" {
		reason = vacated.Status
	}
	days := preferredDays(replacement.PreferredDays, db.Setting(s.db, "club_days", "0|1|2|3|4|5|6"))
	decisionLog := encodeJSON(replacementLog{
		Trigger:              "replacement",
		LastTurnAt:           replacement.LastTurnAt,
		InviteNext:           replacement.InviteNextSince != nil,
		CandidateRank:        candidateRank,
		CandidatesConsidered: candidatesConsidered,
		GroupName:            nonEmpty(groupName),
		GroupColor:           nonEmpty(groupColor),
		ReplacedStudent:      nonEmpty(replacedName),
		ReplacementReason:    reason,
		SameGroupMatch:       sameGroupMatch,
		PreferredTimeslots:   preferredTimeslots,
		PreferredDays:        days,
	})

	token := newToken()
	if _, err := s.db.Exec("INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, group_id, token, decision_log) VALUES (?, ?, ?, ?, ?, ?, ?)",
		sessionID, replacement.ID, vacated.TimeslotID, vacated.SlotID, replacementGroup, token, decisionLog); err != nil {
		return nil, err
	}

	name := replacement.FirstName + " " + replacement.LastName
	s.mailer.SendInvitation(email.InvitationParams{
		To: replacement.Email, StudentName: name, Date: sessionDate, Token: token,
		ClubName: s.clubName(), Locale: s.emailLocale(),
	})
	if _, err := s.db.Exec("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE token = ?", token); err == nil {
		var newID int64
		if s.db.QueryRow("SELECT id FROM invitations WHERE token = ?", token).Scan(&newID) == nil {
			s.scheduleExpiryForInvitation(newID)
		}
	}

	added, err := s.sessionInvitations(sessionDate, "WHERE inv.token = ?", token)
	if err != nil {
		return nil, err
	}
	if len(added) > 0 {
		s.hub.BroadcastSession(sessionID, "invitation_added", added[0])
	}
	s.broadcastSessionCounts(sessionID)

	return &Replacement{Name: name, Email: replacement.Email}, nil
}

// processExpiredInvitation runs when an invitation's expiry timer fires.
func (s *Server) processExpiredInvitation(invitationID int64) error {
	inv, found, err := s.findInvitation("WHERE inv.id = ? AND inv.status = 'invited'", invitationID)
	if err != nil || !found {
		return err // nil: already handled (confirmed, declined, ...)
	}
	if st := inv.SessionStatus; st == "completed" || st == "cancelled" {
		return nil
	}
	sessionID := inv.SessionID
	start, ok := slotStart(inv.SessionDate, inv.StartTime, s.clubLocation())
	slotStarted := ok && !nowFunc().Before(start)
	newStatus := "expired"
	if slotStarted {
		newStatus = "invalidated"
	}
	if _, err := s.db.Exec("UPDATE invitations SET status = ?, responded_at = datetime('now') WHERE id = ?", newStatus, invitationID); err != nil {
		return err
	}

	s.hub.BroadcastSession(sessionID, "invitation_updated", map[string]any{"id": invitationID, "status": newStatus})
	s.broadcastInvitation(inv.Token, newStatus)
	s.broadcastSessionCounts(sessionID)
	s.CreateNotification(NewNotification{
		Type: "invitation_expired", InvitationID: invitationID, SessionID: sessionID,
		StudentName: inv.StudentName, SessionDate: inv.SessionDate, TimeslotStartTime: inv.StartTime,
	})

	if !slotStarted {
		// inv still carries status 'invited', which the decision log records as the reason.
		_, err := s.findAndInviteReplacement(inv.vacated())
		return err
	}
	return nil
}

// --- public routes -----------------------------------------------------------------------

// PublicInvitation is an invitation as shown to the invited student.
type PublicInvitation struct {
	StudentName    string  `json:"student_name"`
	Date           string  `json:"date"`
	StartTime      string  `json:"start_time"`
	Notes          *string `json:"notes"`
	Status         string  `json:"status"` // effective status, see effectiveStatus
	SessionStatus  string  `json:"session_status"`
	DisciplineName *string `json:"discipline_name"`
	ClubName       string  `json:"club_name"`
	Locale         string  `json:"locale"`
	ExpiresAt      *string `json:"expires_at"`
}

func (s *Server) handleGetInvitation(w http.ResponseWriter, r *http.Request) error {
	inv, found, err := s.findInvitation("WHERE inv.token = ?", r.PathValue("token"))
	if err != nil {
		return err
	}
	if !found {
		httpx.Error(w, http.StatusNotFound, "Invitation not found")
		return nil
	}
	minutes, loc := s.expiryMinutes(), s.clubLocation()
	timing := inv.timing()
	status := effectiveStatus(timing, minutes, loc, nowFunc())
	var expiresAt *string
	if status == "invited" {
		expiresAt = expiresAtISO(timing, minutes, loc)
	}
	httpx.OK(w, PublicInvitation{
		StudentName:    inv.StudentName,
		Date:           inv.SessionDate,
		StartTime:      inv.StartTime,
		Notes:          inv.SessionNotes,
		Status:         status,
		SessionStatus:  inv.SessionStatus,
		DisciplineName: nonEmpty(deref(inv.DisciplineName)),
		ClubName:       s.clubName(),
		Locale:         s.emailLocale(),
		ExpiresAt:      expiresAt,
	})
	return nil
}

// loadOpenInvitation fetches the invitation by token and applies the checks shared by the
// public actions. ok is false when a response was already written.
func (s *Server) loadOpenInvitation(w http.ResponseWriter, r *http.Request, requiredStatus string) (invitationDetails, bool, error) {
	inv, found, err := s.findInvitation("WHERE inv.token = ?", r.PathValue("token"))
	if err != nil || !found {
		if err == nil {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
		}
		return inv, false, err
	}
	if inv.SessionStatus == "completed" {
		httpx.Error(w, http.StatusBadRequest, "This session has already passed")
		return inv, false, nil
	}
	if inv.Status != requiredStatus {
		msg := fmt.Sprintf("Invitation already %s", inv.Status)
		if requiredStatus == "confirmed" {
			msg = fmt.Sprintf("Cannot cancel — invitation is %s", inv.Status)
		}
		httpx.Error(w, http.StatusBadRequest, msg)
		return inv, false, nil
	}
	if requiredStatus == "invited" {
		// The expiry timer may not have fired yet.
		if st := effectiveStatus(inv.timing(), s.expiryMinutes(), s.clubLocation(), nowFunc()); st != "invited" {
			msg := "This invitation has expired"
			if st == "invalidated" {
				msg = "This time slot has already started"
			}
			httpx.Error(w, http.StatusBadRequest, msg)
			return inv, false, nil
		}
	}
	return inv, true, nil
}

func (s *Server) handleConfirmInvitation(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		DisciplineID int64 `json:"discipline_id"` // 0 or null: none chosen
	}
	// Lenient: an unreadable body confirms without a discipline.
	if httpx.Decode(r, &in) != nil {
		in.DisciplineID = 0
	}
	inv, ok, err := s.loadOpenInvitation(w, r, "invited")
	if !ok || err != nil {
		return err
	}
	disciplineID := in.DisciplineID
	invID, sessionID := inv.ID, inv.SessionID

	// The discipline must belong to the invitation's group.
	if disciplineID != 0 && inv.GroupID != nil && *inv.GroupID != 0 &&
		!s.exists("SELECT 1 FROM discipline_groups WHERE discipline_id = ? AND group_id = ?", disciplineID, *inv.GroupID) {
		httpx.Error(w, http.StatusBadRequest, "Selected discipline is not available for your group")
		return nil
	}

	var storedDiscipline *int64
	if disciplineID != 0 {
		storedDiscipline = &disciplineID
	}
	if _, err := s.db.Exec("UPDATE invitations SET status = 'confirmed', discipline_id = ?, responded_at = datetime('now') WHERE id = ?", storedDiscipline, invID); err != nil {
		return err
	}
	s.cancelInvitationExpiry(invID)

	var discName, discAbbr *string
	var storedID *int64
	s.db.QueryRow("SELECT discipline_id FROM invitations WHERE id = ?", invID).Scan(&storedID)
	if storedID != nil && *storedID != 0 {
		s.db.QueryRow("SELECT name, abbreviation FROM disciplines WHERE id = ?", *storedID).Scan(&discName, &discAbbr)
	}
	s.hub.BroadcastSession(sessionID, "invitation_updated", map[string]any{
		"id": invID, "status": "confirmed", "discipline_name": discName, "discipline_abbreviation": discAbbr,
	})
	s.broadcastInvitation(r.PathValue("token"), "confirmed")
	s.broadcastSessionCounts(sessionID)

	s.CreateNotification(NewNotification{
		Type: "invitation_confirmed", InvitationID: invID, SessionID: sessionID,
		StudentName: inv.StudentName, SessionDate: inv.SessionDate, TimeslotStartTime: inv.StartTime,
	})
	if full, err := s.sessionFull(sessionID); err != nil {
		return err
	} else if full {
		s.CreateNotification(NewNotification{Type: "session_full", SessionID: sessionID, SessionDate: inv.SessionDate})
	}

	var disciplineName string
	if disciplineID != 0 {
		s.db.QueryRow("SELECT name FROM disciplines WHERE id = ?", disciplineID).Scan(&disciplineName)
	}
	s.mailer.SendConfirmation(email.SessionParams{
		To: inv.StudentEmail, StudentName: inv.StudentName, Date: inv.SessionDate,
		StartTime: inv.StartTime, DisciplineName: disciplineName, ClubName: s.clubName(), Locale: s.emailLocale(),
	}, r.PathValue("token"))

	httpx.OK(w, map[string]any{"success": true, "message": "Your attendance has been confirmed!"})
	return nil
}

func (s *Server) handleCancelInvitation(w http.ResponseWriter, r *http.Request) error {
	inv, ok, err := s.loadOpenInvitation(w, r, "confirmed")
	if !ok || err != nil {
		return err
	}
	invID, sessionID := inv.ID, inv.SessionID
	wasFull, err := s.sessionFull(sessionID)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec("UPDATE invitations SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?", invID); err != nil {
		return err
	}

	s.hub.BroadcastSession(sessionID, "invitation_updated", map[string]any{"id": invID, "status": "cancelled"})
	s.broadcastInvitation(r.PathValue("token"), "cancelled")
	s.broadcastSessionCounts(sessionID)
	s.CreateNotification(NewNotification{
		Type: "invitation_cancelled", InvitationID: invID, SessionID: sessionID,
		StudentName: inv.StudentName, SessionDate: inv.SessionDate, TimeslotStartTime: inv.StartTime,
	})
	if wasFull {
		s.CreateNotification(NewNotification{Type: "session_no_longer_full", SessionID: sessionID, SessionDate: inv.SessionDate})
	}

	s.mailer.SendCancellation(email.SessionParams{
		To: inv.StudentEmail, StudentName: inv.StudentName, Date: inv.SessionDate,
		StartTime: inv.StartTime, DisciplineName: deref(inv.DisciplineName), ClubName: s.clubName(), Locale: s.emailLocale(),
	})

	// The decision log records the status the invitation had when it was loaded.
	replacement, err := s.findAndInviteReplacement(inv.vacated())
	if err != nil {
		return err
	}
	httpx.OK(w, map[string]any{"success": true, "message": "Your participation has been cancelled.", "replacement": replacement})
	return nil
}

func (s *Server) handleDeclineInvitation(w http.ResponseWriter, r *http.Request) error {
	inv, ok, err := s.loadOpenInvitation(w, r, "invited")
	if !ok || err != nil {
		return err
	}
	invID, sessionID := inv.ID, inv.SessionID
	if _, err := s.db.Exec("UPDATE invitations SET status = 'declined', responded_at = datetime('now') WHERE id = ?", invID); err != nil {
		return err
	}
	s.cancelInvitationExpiry(invID)

	s.hub.BroadcastSession(sessionID, "invitation_updated", map[string]any{"id": invID, "status": "declined"})
	s.broadcastInvitation(r.PathValue("token"), "declined")
	s.broadcastSessionCounts(sessionID)

	s.CreateNotification(NewNotification{
		Type: "invitation_declined", InvitationID: invID, SessionID: sessionID,
		StudentName: inv.StudentName, SessionDate: inv.SessionDate, TimeslotStartTime: inv.StartTime,
	})

	replacement, err := s.findAndInviteReplacement(inv.vacated())
	if err != nil {
		return err
	}
	httpx.OK(w, map[string]any{"success": true, "message": "Your decline has been recorded.", "replacement": replacement})
	return nil
}
