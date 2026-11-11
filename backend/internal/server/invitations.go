package server

import (
	"fmt"
	"net/http"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
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
		InvitationID: i.ID, GroupID: i.GroupID, StudentID: i.StudentID, Status: i.Status,
	}
}

func (s *Server) invitationRoutes() {
	s.publicRoute("GET /api/invitations/{token}", s.handleGetInvitation)
	s.publicRoute("POST /api/invitations/{token}/confirm", s.handleConfirmInvitation)
	s.publicRoute("POST /api/invitations/{token}/cancel", s.handleCancelInvitation)
	s.publicRoute("POST /api/invitations/{token}/decline", s.handleDeclineInvitation)
}

func (s *Server) broadcastInvitation(token, status string) {
	s.hub.Broadcast("invitation:"+token, "invitation_updated", map[string]any{"status": status})
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
