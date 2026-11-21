package server

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

// invitationDetails is an invitation with the session, student, timeslot and discipline
// details the invitation actions need. Load it with selectInvitationDetails.
type invitationDetails struct {
	ID             int64   `db:"id"`
	SessionID      int64   `db:"session_id"`
	StudentID      int64   `db:"student_id"`
	TimeslotID     int64   `db:"timeslot_id"`
	SlotID         int64   `db:"slot_id"`
	GroupID        *int64  `db:"group_id"`
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
	DisciplineName string  `db:"discipline_name"` // "" when the invitation has no discipline
}

// selectInvitationDetails selects invitationDetails rows, for invitationByID and invitationByToken.
const selectInvitationDetails = `
	SELECT inv.id, inv.session_id, inv.student_id, inv.timeslot_id, inv.slot_id, inv.group_id,
		inv.token, inv.status, inv.invited_at, inv.email_sent,
		ts.date AS session_date, ts.status AS session_status, ts.notes AS session_notes,
		s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
		tslot.start_time, COALESCE(d.name, '') AS discipline_name
	FROM invitations inv
	JOIN training_sessions ts ON ts.id = inv.session_id
	JOIN students s ON s.id = inv.student_id
	JOIN timeslots tslot ON tslot.id = inv.timeslot_id
	LEFT JOIN disciplines d ON d.id = inv.discipline_id`

// invitationByID loads the invitation with the given id.
func (s *Server) invitationByID(id int64) (invitationDetails, bool, error) {
	return db.One[invitationDetails](s.db, selectInvitationDetails+`
		WHERE inv.id = ?`, id)
}

// invitationByToken loads the invitation with the given public token.
func (s *Server) invitationByToken(token string) (invitationDetails, bool, error) {
	return db.One[invitationDetails](s.db, selectInvitationDetails+`
		WHERE inv.token = ?`, token)
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

// broadcastInvitation pushes a status change to the student-facing per-token invitation channel.
func (s *Server) broadcastInvitation(token, status string) {
	s.hub.Broadcast(invitationChannel(token), "invitation_updated", map[string]any{"status": status})
}

// PublicInvitation is an invitation as shown to the invited student.
type PublicInvitation struct {
	StudentName    string  `json:"student_name"`
	Date           string  `json:"date"`
	StartTime      string  `json:"start_time"`
	Notes          *string `json:"notes"`
	Status         string  `json:"status"` // effective status, see effectiveStatus
	SessionStatus  string  `json:"session_status"`
	DisciplineName string  `json:"discipline_name"`
	ClubName       string  `json:"club_name"`
	Locale         string  `json:"locale"`
	ExpiresAt      *string `json:"expires_at"`
}

// invitationExpired reports whether an invitation stored as 'invited' can no longer be
// answered, and if so why. The expiry timer may not have updated the stored status yet.
func (s *Server) invitationExpired(inv invitationDetails) (reason string, expired bool) {
	switch effectiveStatus(inv.timing(), s.expiryMinutes(), s.clubLocation(), nowFunc()) {
	case "invited":
		return "", false
	case "invalidated":
		return "This time slot has already started", true
	default:
		return "This invitation has expired", true
	}
}

// Invitation status changes live here, whichever route or timer triggers them. They take an
// invitation id and load what they need themselves: each updates the invitation, its expiry
// timer and the student's invitation page, and sends the emails and notifications that go
// with it. Callers only decide which invitations to change.

// sendInvitation emails the invitation to the student, marks it invited and starts its
// expiry timer. Session-wide broadcasts are left to the caller, which may send several.
func (s *Server) sendInvitation(invitationID int64) error {
	inv, found, err := s.invitationByID(invitationID)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("invitation %d not found", invitationID)
	}
	s.mailer.SendInvitation(email.InvitationParams{
		To: inv.StudentEmail, StudentName: inv.StudentName, Date: inv.SessionDate, Token: inv.Token,
		ClubName: s.clubName(), Locale: s.emailLocale(),
	})
	invitedAt := nowFunc().UTC().Format(time.DateTime) // the format of datetime('now')
	if _, err := s.db.Exec("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = ? WHERE id = ?", invitedAt, invitationID); err != nil {
		return err
	}
	if deadline, ok := invitationDeadline(invitedAt, inv.SessionDate, inv.StartTime, s.expiryMinutes(), s.clubLocation()); ok {
		s.scheduleInvitationExpiry(invitationID, deadline)
	}
	return nil
}

// adminCancelInvitation cancels an invitation on the admin's behalf and, if the invitation
// was emailed, tells the student. Session-wide broadcasts are left to the caller, which may
// cancel several.
func (s *Server) adminCancelInvitation(invitationID int64) error {
	inv, found, err := s.invitationByID(invitationID)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("invitation %d not found", invitationID)
	}
	if _, err := s.db.Exec("UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE id = ?", inv.ID); err != nil {
		return err
	}
	s.cancelInvitationExpiry(inv.ID)
	s.broadcastInvitation(inv.Token, "admin_cancelled")
	if inv.EmailSent != 0 {
		s.mailer.SendAdminCancellation(email.SessionParams{
			To: inv.StudentEmail, StudentName: inv.StudentName, Date: inv.SessionDate,
			StartTime: inv.StartTime, DisciplineName: inv.DisciplineName,
			ClubName: s.clubName(), Locale: s.emailLocale(),
		})
	}
	return nil
}

// expireInvitation runs when an invitation's expiry timer fires. An invitation whose slot
// has started is invalidated; otherwise it expires and a replacement is invited.
func (s *Server) expireInvitation(invitationID int64) error {
	inv, found, err := s.invitationByID(invitationID)
	if err != nil || !found || inv.Status != "invited" {
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

	s.broadcastSessionInvitation(sessionID, invitationID, map[string]any{"status": newStatus})
	s.broadcastInvitation(inv.Token, newStatus)
	s.broadcastSessionCounts(sessionID)
	s.notifyInvitation("invitation_expired", inv)

	if !slotStarted {
		// inv still carries status 'invited', which the decision log records as the reason.
		_, err := s.findAndInviteReplacement(inv.vacated())
		return err
	}
	return nil
}

func (s *Server) invitationRoutes() {
	s.publicRoute("GET /api/invitations/{token}", func(w http.ResponseWriter, r *http.Request) error {
		inv, found, err := s.invitationByToken(r.PathValue("token"))
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
			DisciplineName: inv.DisciplineName,
			ClubName:       s.clubName(),
			Locale:         s.emailLocale(),
			ExpiresAt:      expiresAt,
		})
		return nil
	})

	s.publicRoute("POST /api/invitations/{token}/confirm", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			DisciplineID *int64 `json:"discipline_id"` // null or missing: none chosen
		}
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		inv, found, err := s.invitationByToken(r.PathValue("token"))
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}
		if inv.SessionStatus == "completed" {
			httpx.Error(w, http.StatusBadRequest, "This session has already passed")
			return nil
		}
		if inv.Status != "invited" {
			httpx.Error(w, http.StatusBadRequest, fmt.Sprintf("Invitation already %s", inv.Status))
			return nil
		}
		if reason, expired := s.invitationExpired(inv); expired {
			httpx.Error(w, http.StatusBadRequest, reason)
			return nil
		}
		invID, sessionID := inv.ID, inv.SessionID

		// The discipline must belong to the invitation's group, or for manual invitations
		// (no group) to the student's current group.
		if in.DisciplineID != nil {
			if _, found, err := db.One[int](s.db, `
				SELECT 1 FROM discipline_groups
				WHERE discipline_id = ?
				  AND group_id = COALESCE(?, (SELECT group_id FROM student_groups WHERE student_id = ?))`,
				*in.DisciplineID, inv.GroupID, inv.StudentID); err != nil {
				return err
			} else if !found {
				httpx.Error(w, http.StatusBadRequest, "Selected discipline is not available for your group")
				return nil
			}
		}
		// Loaded before confirming, so a failed lookup changes nothing.
		var discName, discAbbr *string
		if in.DisciplineID != nil {
			d, found, err := s.getDiscipline(*in.DisciplineID)
			if err != nil {
				return err
			}
			if found {
				discName, discAbbr = &d.Name, &d.Abbreviation
			}
		}

		if _, err := s.db.Exec("UPDATE invitations SET status = 'confirmed', discipline_id = ?, responded_at = datetime('now') WHERE id = ?", in.DisciplineID, invID); err != nil {
			return err
		}
		s.cancelInvitationExpiry(invID)

		s.broadcastSessionInvitation(sessionID, invID, map[string]any{
			"status": "confirmed", "discipline_name": discName, "discipline_abbreviation": discAbbr,
		})
		s.broadcastInvitation(inv.Token, "confirmed")
		s.broadcastSessionCounts(sessionID)

		s.notifyInvitation("invitation_confirmed", inv)
		// The confirmation is saved; a failed check only costs the "session full" notification.
		if full, err := s.sessionFull(sessionID); err != nil {
			log.Printf("session full %d: %v", sessionID, err)
		} else if full {
			s.notifySession("session_full", sessionID, inv.SessionDate)
		}

		var disciplineName string
		if discName != nil {
			disciplineName = *discName
		}
		s.mailer.SendConfirmation(email.SessionParams{
			To: inv.StudentEmail, StudentName: inv.StudentName, Date: inv.SessionDate,
			StartTime: inv.StartTime, DisciplineName: disciplineName, ClubName: s.clubName(), Locale: s.emailLocale(),
		}, inv.Token)

		httpx.OK(w, map[string]any{"success": true, "message": "Your attendance has been confirmed!"})
		return nil
	})

	s.publicRoute("POST /api/invitations/{token}/decline", func(w http.ResponseWriter, r *http.Request) error {
		inv, found, err := s.invitationByToken(r.PathValue("token"))
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}
		if inv.SessionStatus == "completed" {
			httpx.Error(w, http.StatusBadRequest, "This session has already passed")
			return nil
		}
		if inv.Status != "invited" {
			httpx.Error(w, http.StatusBadRequest, fmt.Sprintf("Invitation already %s", inv.Status))
			return nil
		}
		if reason, expired := s.invitationExpired(inv); expired {
			httpx.Error(w, http.StatusBadRequest, reason)
			return nil
		}
		invID, sessionID := inv.ID, inv.SessionID
		if _, err := s.db.Exec("UPDATE invitations SET status = 'declined', responded_at = datetime('now') WHERE id = ?", invID); err != nil {
			return err
		}
		s.cancelInvitationExpiry(invID)

		s.broadcastSessionInvitation(sessionID, invID, map[string]any{"status": "declined"})
		s.broadcastInvitation(inv.Token, "declined")
		s.broadcastSessionCounts(sessionID)

		s.notifyInvitation("invitation_declined", inv)

		if _, err := s.findAndInviteReplacement(inv.vacated()); err != nil {
			return err
		}
		httpx.OK(w, map[string]any{"success": true, "message": "Your decline has been recorded."})
		return nil
	})

	s.publicRoute("POST /api/invitations/{token}/cancel", func(w http.ResponseWriter, r *http.Request) error {
		inv, found, err := s.invitationByToken(r.PathValue("token"))
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}
		if inv.SessionStatus == "completed" {
			httpx.Error(w, http.StatusBadRequest, "This session has already passed")
			return nil
		}
		if inv.Status != "confirmed" {
			httpx.Error(w, http.StatusBadRequest, fmt.Sprintf("Cannot cancel — invitation is %s", inv.Status))
			return nil
		}
		invID, sessionID := inv.ID, inv.SessionID
		wasFull, err := s.sessionFull(sessionID)
		if err != nil {
			return err
		}
		if _, err := s.db.Exec("UPDATE invitations SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?", invID); err != nil {
			return err
		}

		s.broadcastSessionInvitation(sessionID, invID, map[string]any{"status": "cancelled"})
		s.broadcastInvitation(inv.Token, "cancelled")
		s.broadcastSessionCounts(sessionID)
		s.notifyInvitation("invitation_cancelled", inv)
		if wasFull {
			s.notifySession("session_no_longer_full", sessionID, inv.SessionDate)
		}

		s.mailer.SendCancellation(email.SessionParams{
			To: inv.StudentEmail, StudentName: inv.StudentName, Date: inv.SessionDate,
			StartTime: inv.StartTime, DisciplineName: inv.DisciplineName, ClubName: s.clubName(), Locale: s.emailLocale(),
		})

		// The decision log records the status the invitation had when it was loaded.
		if _, err := s.findAndInviteReplacement(inv.vacated()); err != nil {
			return err
		}
		httpx.OK(w, map[string]any{"success": true, "message": "Your participation has been cancelled."})
		return nil
	})
}
