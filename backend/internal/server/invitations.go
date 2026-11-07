package server

import (
	"bytes"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
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

// marshalJS encodes like JSON.stringify: struct field order, no HTML escaping.
func marshalJS(v any) string {
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

// numberKey returns v as an integer id if it is a JSON/SQLite number with an integral value.
// JS Set/Map lookups are strict, so strings never match numeric ids.
func numberKey(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case float64:
		if x == float64(int64(x)) {
			return int64(x), true
		}
	}
	return 0, false
}

func str(row map[string]any, key string) string {
	v, _ := row[key].(string)
	return v
}

// preferredDays filters a student's preferred days to the club days; nil when it covers
// all club days (mirrors the decision-log logic in sessions.ts / invitations.ts).
func preferredDays(studentDays, clubDays string) []any {
	if studentDays == "" {
		return nil
	}
	clubSet := map[string]bool{}
	for _, d := range strings.Split(clubDays, "|") {
		clubSet[jsNumberKey(d)] = true
	}
	out := []any{}
	for _, d := range strings.Split(studentDays, "|") {
		k := jsNumberKey(d)
		if clubSet[k] {
			if n, err := strconv.ParseFloat(k, 64); err == nil {
				out = append(out, n)
			} else {
				out = append(out, nil) // NaN serializes as null
			}
		}
	}
	if len(out) >= len(clubSet) {
		return nil
	}
	return out
}

// jsNumberKey normalizes a string the way Number() would, for set membership.
func jsNumberKey(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "0"
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return "NaN"
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func (s *Server) prefsByStudent(timetableID any) (map[int64]map[int64]bool, error) {
	rows, err := db.All(s.db, "SELECT student_id, timeslot_id FROM student_preferred_timeslots WHERE timetable_id = ?", timetableID)
	if err != nil {
		return nil, err
	}
	out := map[int64]map[int64]bool{}
	for _, r := range rows {
		sid := toInt64(r["student_id"])
		if out[sid] == nil {
			out[sid] = map[int64]bool{}
		}
		out[sid][toInt64(r["timeslot_id"])] = true
	}
	return out, nil
}

// --- replacement -------------------------------------------------------------------------

type replacementLog struct {
	Trigger              string `json:"trigger"`
	LastTurnAt           any    `json:"last_turn_at"`
	InviteNext           bool   `json:"invite_next"`
	CandidateRank        int    `json:"candidate_rank"`
	CandidatesConsidered int    `json:"candidates_considered"`
	GroupName            any    `json:"group_name"`
	GroupColor           any    `json:"group_color"`
	ReplacedStudent      any    `json:"replaced_student"`
	ReplacementReason    any    `json:"replacement_reason"`
	SameGroupMatch       bool   `json:"same_group_match"`
	PreferredTimeslots   any    `json:"preferred_timeslots"`
	PreferredDays        any    `json:"preferred_days"`
}

// findAndInviteReplacement invites the next student in line for a vacated spot. vacated
// needs session_id, session_date, timeslot_id, slot_id and group_id; student_id and status
// are optional (they only feed the decision log). Returns nil when nobody is eligible.
func (s *Server) findAndInviteReplacement(vacated map[string]any) (map[string]any, error) {
	sessionID := toInt64(vacated["session_id"])
	sessionDate := str(vacated, "session_date")

	invitedRows, err := db.All(s.db, "SELECT student_id FROM invitations WHERE session_id = ?", sessionID)
	if err != nil {
		return nil, err
	}
	alreadyInvited := make([]any, len(invitedRows))
	for i, r := range invitedRows {
		alreadyInvited[i] = r["student_id"]
	}

	var timetableID any
	s.db.QueryRow("SELECT timetable_id FROM training_sessions WHERE id = ?", sessionID).Scan(&timetableID)

	timetableGroups := map[int64]bool{}
	percentageByGroup := map[int64]float64{}
	if truthy(timetableID) {
		rows, err := db.All(s.db, "SELECT group_id, percentage FROM timetable_groups WHERE timetable_id = ?", timetableID)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			gid := toInt64(r["group_id"])
			timetableGroups[gid] = true
			percentageByGroup[gid] = float64(toInt64(r["percentage"]))
		}
	}

	discRows, err := db.All(s.db, "SELECT DISTINCT dg.group_id FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id WHERE d.active = 1")
	if err != nil {
		return nil, err
	}
	discGroups := map[int64]bool{}
	for _, r := range discRows {
		discGroups[toInt64(r["group_id"])] = true
	}

	dow := "NaN"
	if d, ok := dayOfWeek(sessionDate); ok {
		dow = strconv.Itoa(d)
	}
	queryArgs := append([]any{dow, sessionDate}, alreadyInvited...)
	queryArgs = append(queryArgs, sessionDate)
	candidates, err := db.All(s.db, `
		SELECT s.*, `+queue.ColumnsSQL+` FROM students s
		JOIN student_groups sg ON sg.student_id = s.id
		`+queue.JoinSQL+`
		WHERE s.active = 1
			AND s.deleted_at IS NULL
			AND ('|' || s.preferred_days || '|') LIKE '%|' || ? || '|%'
			AND (s.cooldown_until IS NULL OR date(s.cooldown_until) <= ?)
			AND s.id NOT IN (`+placeholders(len(alreadyInvited))+`)
			AND s.id NOT IN (
				SELECT inv.student_id FROM invitations inv
				JOIN training_sessions ts ON ts.id = inv.session_id
				WHERE ts.date = ? AND inv.status NOT IN `+terminalStatuses+`
			)
		ORDER BY `+queue.OrderSQL+`, RANDOM()`, queryArgs...)
	if err != nil {
		return nil, err
	}

	prefs := map[int64]map[int64]bool{}
	if truthy(timetableID) {
		if prefs, err = s.prefsByStudent(timetableID); err != nil {
			return nil, err
		}
	}
	timeslotKey, timeslotIsNumber := numberKey(vacated["timeslot_id"])
	prefersTimeslot := func(studentID int64) bool {
		p := prefs[studentID]
		return len(p) == 0 || (timeslotIsNumber && p[timeslotKey])
	}
	// eligibleGroup returns the student's group if it can take this spot.
	eligibleGroup := func(studentID int64) (int64, bool, error) {
		var gid int64
		switch err := s.db.QueryRow("SELECT group_id FROM student_groups WHERE student_id = ?", studentID).Scan(&gid); {
		case err == nil:
		case errors.Is(err, sql.ErrNoRows):
			return 0, false, nil
		default:
			return 0, false, err
		}
		return gid, gid != 0 && timetableGroups[gid] && discGroups[gid], nil
	}

	originalGroup, hasOriginal := numberKey(vacated["group_id"])
	hasOriginal = hasOriginal && originalGroup != 0
	var replacement map[string]any
	var replacementGroup any = vacated["group_id"]
	sameGroupMatch := false
	candidateRank, candidatesConsidered := 0, len(candidates)

	// First pass: a replacement from the same group as the original invitation.
	for _, st := range candidates {
		id := toInt64(st["id"])
		if !prefersTimeslot(id) {
			continue
		}
		gid, ok, err := eligibleGroup(id)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		candidateRank++
		if !hasOriginal || gid == originalGroup {
			replacement, replacementGroup, sameGroupMatch = st, gid, true
			break
		}
	}

	// Second pass: any timetable group, picked at random weighted by its percentage; then
	// the first candidate in that group's queue.
	if replacement == nil && hasOriginal && len(timetableGroups) > 0 {
		var groupOrder []int64
		byGroup := map[int64][]map[string]any{}
		for _, st := range candidates {
			id := toInt64(st["id"])
			if !prefersTimeslot(id) {
				continue
			}
			gid, ok, err := eligibleGroup(id)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			if _, seen := byGroup[gid]; !seen {
				groupOrder = append(groupOrder, gid)
			}
			byGroup[gid] = append(byGroup[gid], st)
		}
		if len(groupOrder) > 0 {
			picked := queue.WeightedPickGroup(groupOrder, percentageByGroup, mrand.Float64)
			q := byGroup[picked]
			replacement, replacementGroup, sameGroupMatch = q[0], picked, false
			candidateRank, candidatesConsidered = 1, len(q)
		}
	}

	if replacement == nil {
		return nil, nil
	}

	var replacedName, groupName, groupColor any
	s.db.QueryRow("SELECT first_name || ' ' || last_name FROM students WHERE id = ?", arg(vacated["student_id"])).Scan(&replacedName)
	if truthy(replacementGroup) {
		s.db.QueryRow("SELECT name, color FROM groups WHERE id = ?", replacementGroup).Scan(&groupName, &groupColor)
	}

	replacementID := toInt64(replacement["id"])
	var preferredTimeslots any
	if p := prefs[replacementID]; len(p) > 0 && truthy(timetableID) {
		slots, err := db.All(s.db, "SELECT id, start_time FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC", timetableID)
		if err != nil {
			return nil, err
		}
		list := []any{}
		for _, t := range slots {
			if p[toInt64(t["id"])] {
				list = append(list, t["start_time"])
			}
		}
		preferredTimeslots = list
	}

	reason := any("vacated")
	if truthy(vacated["status"]) {
		reason = vacated["status"]
	}
	days := preferredDays(str(replacement, "preferred_days"), db.Setting(s.db, "club_days", "0|1|2|3|4|5|6"))
	decisionLog := marshalJS(replacementLog{
		Trigger:              "replacement",
		LastTurnAt:           replacement["last_turn_at"],
		InviteNext:           replacement["invite_next_since"] != nil,
		CandidateRank:        candidateRank,
		CandidatesConsidered: candidatesConsidered,
		GroupName:            orNull(groupName),
		GroupColor:           orNull(groupColor),
		ReplacedStudent:      orNull(replacedName),
		ReplacementReason:    reason,
		SameGroupMatch:       sameGroupMatch,
		PreferredTimeslots:   preferredTimeslots,
		PreferredDays:        nilIfEmpty(days),
	})

	token := newToken()
	if _, err := s.db.Exec("INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, group_id, token, decision_log) VALUES (?, ?, ?, ?, ?, ?, ?)",
		sessionID, replacementID, arg(vacated["timeslot_id"]), arg(vacated["slot_id"]), arg(replacementGroup), token, decisionLog); err != nil {
		return nil, err
	}

	name := str(replacement, "first_name") + " " + str(replacement, "last_name")
	s.mailer.SendInvitation(email.InvitationParams{
		To: str(replacement, "email"), StudentName: name, Date: sessionDate, Token: token,
		ClubName: s.clubName(), Locale: s.emailLocale(),
	})
	if _, err := s.db.Exec("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE token = ?", token); err == nil {
		var newID int64
		if s.db.QueryRow("SELECT id FROM invitations WHERE token = ?", token).Scan(&newID) == nil {
			s.scheduleExpiryForInvitation(newID)
		}
	}

	full, err := db.Get(s.db, `
		SELECT inv.*, inv.no_show, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email, s.membership_id AS student_membership_id, s.attended_sessions,
			d.name AS discipline_name, d.abbreviation AS discipline_abbreviation, ts.start_time AS timeslot_start_time,
			ss.instructor_id AS instructor_id, i.first_name || ' ' || i.last_name AS instructor_name,
			g.name AS group_name, g.color AS group_color
		FROM invitations inv
		JOIN students s ON s.id = inv.student_id
		JOIN timeslots ts ON ts.id = inv.timeslot_id
		JOIN session_slots ss ON ss.id = inv.slot_id
		JOIN instructors i ON i.id = ss.instructor_id
		LEFT JOIN disciplines d ON d.id = inv.discipline_id
		LEFT JOIN groups g ON g.id = inv.group_id
		WHERE inv.token = ?`, token)
	if err != nil {
		return nil, err
	}
	if full != nil {
		timing := timingOf(full, "")
		timing.SessionDate = sessionDate
		full["expires_at"] = expiresAtISO(timing, s.expiryMinutes(), s.clubLocation())
		s.hub.BroadcastSession(sessionID, "invitation_added", full)
	}
	s.broadcastSessionCounts(sessionID)

	return map[string]any{"name": name, "email": replacement["email"]}, nil
}

func orNull(v any) any {
	if !truthy(v) {
		return nil
	}
	return v
}

func nilIfEmpty(days []any) any {
	if days == nil {
		return nil
	}
	return days
}

// processExpiredInvitation runs when an invitation's expiry timer fires.
func (s *Server) processExpiredInvitation(invitationID int64) error {
	inv, err := db.Get(s.db, `
		SELECT inv.*, ts.date AS session_date, ts.id AS session_id, ts.status AS session_status,
			s.first_name || ' ' || s.last_name AS student_name,
			tslot.start_time AS timeslot_start_time
		FROM invitations inv
		JOIN training_sessions ts ON ts.id = inv.session_id
		JOIN students s ON s.id = inv.student_id
		JOIN timeslots tslot ON tslot.id = inv.timeslot_id
		WHERE inv.id = ? AND inv.status = 'invited'`, invitationID)
	if err != nil || inv == nil {
		return err // nil: already handled (confirmed, declined, ...)
	}
	if st := inv["session_status"]; st == "completed" || st == "cancelled" {
		return nil
	}
	sessionID := toInt64(inv["session_id"])
	start, ok := slotStart(str(inv, "session_date"), str(inv, "timeslot_start_time"), s.clubLocation())
	slotStarted := ok && !nowFunc().Before(start)
	newStatus := "expired"
	if slotStarted {
		newStatus = "invalidated"
	}
	if _, err := s.db.Exec("UPDATE invitations SET status = ?, responded_at = datetime('now') WHERE id = ?", newStatus, invitationID); err != nil {
		return err
	}

	s.hub.BroadcastSession(sessionID, "invitation_updated", map[string]any{"id": invitationID, "status": newStatus})
	s.broadcastInvitation(str(inv, "token"), newStatus)
	s.broadcastSessionCounts(sessionID)
	s.CreateNotification(Notification{
		Type: "invitation_expired", InvitationID: invitationID, SessionID: sessionID,
		StudentName: str(inv, "student_name"), SessionDate: str(inv, "session_date"), TimeslotStartTime: str(inv, "timeslot_start_time"),
	})

	if !slotStarted {
		// inv still carries status 'invited', which the decision log records as the reason.
		_, err := s.findAndInviteReplacement(inv)
		return err
	}
	return nil
}

// --- public routes -----------------------------------------------------------------------

const invitationByTokenSQL = `
	SELECT inv.*, ts.status AS session_status, ts.date AS session_date, ts.id AS session_id,
		s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
		tslot.start_time AS timeslot_start_time
	FROM invitations inv
	JOIN training_sessions ts ON ts.id = inv.session_id
	JOIN students s ON s.id = inv.student_id
	JOIN timeslots tslot ON tslot.id = inv.timeslot_id
	WHERE inv.token = ?`

func (s *Server) handleGetInvitation(w http.ResponseWriter, r *http.Request) error {
	inv, err := db.Get(s.db, `
		SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
			ts.date AS session_date, ts.notes AS session_notes, ts.status AS session_status,
			tslot.start_time AS timeslot_start_time,
			d.name AS discipline_name
		FROM invitations inv
		JOIN students s ON s.id = inv.student_id
		JOIN training_sessions ts ON ts.id = inv.session_id
		JOIN timeslots tslot ON tslot.id = inv.timeslot_id
		LEFT JOIN disciplines d ON d.id = inv.discipline_id
		WHERE inv.token = ?`, r.PathValue("token"))
	if err != nil {
		return err
	}
	if inv == nil {
		httpx.Error(w, http.StatusNotFound, "Invitation not found")
		return nil
	}
	minutes, loc := s.expiryMinutes(), s.clubLocation()
	timing := timingOf(inv, "session_date")
	status := effectiveStatus(timing, minutes, loc, nowFunc())
	var expiresAt any
	if status == "invited" {
		expiresAt = expiresAtISO(timing, minutes, loc)
	}
	httpx.OK(w, map[string]any{
		"student_name":    inv["student_name"],
		"date":            inv["session_date"],
		"start_time":      inv["timeslot_start_time"],
		"notes":           inv["session_notes"],
		"status":          status,
		"session_status":  inv["session_status"],
		"discipline_name": orNull(inv["discipline_name"]),
		"club_name":       s.clubName(),
		"locale":          s.emailLocale(),
		"expires_at":      expiresAt,
	})
	return nil
}

// loadOpenInvitation fetches the invitation by token and applies the checks shared by the
// public actions. ok is false when a response was already written.
func (s *Server) loadOpenInvitation(w http.ResponseWriter, r *http.Request, requiredStatus string) (map[string]any, bool, error) {
	inv, err := db.Get(s.db, invitationByTokenSQL, r.PathValue("token"))
	if err != nil {
		return nil, false, err
	}
	if inv == nil {
		httpx.Error(w, http.StatusNotFound, "Invitation not found")
		return nil, false, nil
	}
	if inv["session_status"] == "completed" {
		httpx.Error(w, http.StatusBadRequest, "This session has already passed")
		return nil, false, nil
	}
	if inv["status"] != requiredStatus {
		msg := fmt.Sprintf("Invitation already %s", jsString(inv["status"]))
		if requiredStatus == "confirmed" {
			msg = fmt.Sprintf("Cannot cancel — invitation is %s", jsString(inv["status"]))
		}
		httpx.Error(w, http.StatusBadRequest, msg)
		return nil, false, nil
	}
	if requiredStatus == "invited" {
		// The expiry timer may not have fired yet.
		if st := effectiveStatus(timingOf(inv, "session_date"), s.expiryMinutes(), s.clubLocation(), nowFunc()); st != "invited" {
			msg := "This invitation has expired"
			if st == "invalidated" {
				msg = "This time slot has already started"
			}
			httpx.Error(w, http.StatusBadRequest, msg)
			return nil, false, nil
		}
	}
	return inv, true, nil
}

func (s *Server) handleConfirmInvitation(w http.ResponseWriter, r *http.Request) error {
	b, err := readBody(r)
	if err != nil {
		b = body{}
	}
	inv, ok, err := s.loadOpenInvitation(w, r, "invited")
	if !ok || err != nil {
		return err
	}
	disciplineID := b["discipline_id"]
	invID, sessionID := toInt64(inv["id"]), toInt64(inv["session_id"])

	// The discipline must belong to the invitation's group.
	if truthy(disciplineID) && truthy(inv["group_id"]) &&
		!s.exists("SELECT 1 FROM discipline_groups WHERE discipline_id = ? AND group_id = ?", arg(disciplineID), inv["group_id"]) {
		httpx.Error(w, http.StatusBadRequest, "Selected discipline is not available for your group")
		return nil
	}

	var storedDiscipline any
	if truthy(disciplineID) {
		storedDiscipline = arg(disciplineID)
	}
	if _, err := s.db.Exec("UPDATE invitations SET status = 'confirmed', discipline_id = ?, responded_at = datetime('now') WHERE id = ?", storedDiscipline, invID); err != nil {
		return err
	}
	s.cancelInvitationExpiry(invID)

	var discName, discAbbr any
	var storedID any
	s.db.QueryRow("SELECT discipline_id FROM invitations WHERE id = ?", invID).Scan(&storedID)
	if truthy(storedID) {
		s.db.QueryRow("SELECT name, abbreviation FROM disciplines WHERE id = ?", storedID).Scan(&discName, &discAbbr)
	}
	s.hub.BroadcastSession(sessionID, "invitation_updated", map[string]any{
		"id": invID, "status": "confirmed", "discipline_name": discName, "discipline_abbreviation": discAbbr,
	})
	s.broadcastInvitation(r.PathValue("token"), "confirmed")
	s.broadcastSessionCounts(sessionID)

	s.CreateNotification(Notification{
		Type: "invitation_confirmed", InvitationID: invID, SessionID: sessionID,
		StudentName: str(inv, "student_name"), SessionDate: str(inv, "session_date"), TimeslotStartTime: str(inv, "timeslot_start_time"),
	})
	if full, err := s.sessionFull(sessionID); err != nil {
		return err
	} else if full {
		s.CreateNotification(Notification{Type: "session_full", SessionID: sessionID, SessionDate: str(inv, "session_date")})
	}

	var disciplineName string
	if truthy(disciplineID) {
		s.db.QueryRow("SELECT name FROM disciplines WHERE id = ?", arg(disciplineID)).Scan(&disciplineName)
	}
	s.mailer.SendConfirmation(email.SessionParams{
		To: str(inv, "student_email"), StudentName: str(inv, "student_name"), Date: str(inv, "session_date"),
		StartTime: str(inv, "timeslot_start_time"), DisciplineName: disciplineName, ClubName: s.clubName(), Locale: s.emailLocale(),
	}, r.PathValue("token"))

	httpx.OK(w, map[string]any{"success": true, "message": "Your attendance has been confirmed!"})
	return nil
}

func (s *Server) handleCancelInvitation(w http.ResponseWriter, r *http.Request) error {
	inv, ok, err := s.loadOpenInvitation(w, r, "confirmed")
	if !ok || err != nil {
		return err
	}
	invID, sessionID := toInt64(inv["id"]), toInt64(inv["session_id"])
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
	s.CreateNotification(Notification{
		Type: "invitation_cancelled", InvitationID: invID, SessionID: sessionID,
		StudentName: str(inv, "student_name"), SessionDate: str(inv, "session_date"), TimeslotStartTime: str(inv, "timeslot_start_time"),
	})
	if wasFull {
		s.CreateNotification(Notification{Type: "session_no_longer_full", SessionID: sessionID, SessionDate: str(inv, "session_date")})
	}

	var disciplineName string
	if truthy(inv["discipline_id"]) {
		s.db.QueryRow("SELECT name FROM disciplines WHERE id = ?", inv["discipline_id"]).Scan(&disciplineName)
	}
	s.mailer.SendCancellation(email.SessionParams{
		To: str(inv, "student_email"), StudentName: str(inv, "student_name"), Date: str(inv, "session_date"),
		StartTime: str(inv, "timeslot_start_time"), DisciplineName: disciplineName, ClubName: s.clubName(), Locale: s.emailLocale(),
	})

	// The decision log records the status the invitation had when it was loaded.
	replacement, err := s.findAndInviteReplacement(inv)
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
	invID, sessionID := toInt64(inv["id"]), toInt64(inv["session_id"])
	if _, err := s.db.Exec("UPDATE invitations SET status = 'declined', responded_at = datetime('now') WHERE id = ?", invID); err != nil {
		return err
	}
	s.cancelInvitationExpiry(invID)

	s.hub.BroadcastSession(sessionID, "invitation_updated", map[string]any{"id": invID, "status": "declined"})
	s.broadcastInvitation(r.PathValue("token"), "declined")
	s.broadcastSessionCounts(sessionID)

	studentName := "Unknown"
	s.db.QueryRow("SELECT first_name || ' ' || last_name FROM students WHERE id = ?", inv["student_id"]).Scan(&studentName)
	s.CreateNotification(Notification{
		Type: "invitation_declined", InvitationID: invID, SessionID: sessionID,
		StudentName: studentName, SessionDate: str(inv, "session_date"), TimeslotStartTime: str(inv, "timeslot_start_time"),
	})

	replacement, err := s.findAndInviteReplacement(inv)
	if err != nil {
		return err
	}
	httpx.OK(w, map[string]any{"success": true, "message": "Your decline has been recorded.", "replacement": replacement})
	return nil
}
