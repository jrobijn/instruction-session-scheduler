package server

import (
	"sync"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
)

// expiryTimers holds one timer per invited invitation. Timer callbacks take the server lock, like handlers do.
type expiryTimers struct {
	mu     sync.Mutex
	timers map[int64]*time.Timer
}

func (s *Server) scheduleInvitationExpiry(invitationID int64, at time.Time) {
	s.cancelInvitationExpiry(invitationID)
	t := s.timers
	t.mu.Lock()
	defer t.mu.Unlock()
	var timer *time.Timer
	timer = time.AfterFunc(max(0, time.Until(at)), func() {
		t.mu.Lock()
		current := t.timers[invitationID] == timer
		if current {
			delete(t.timers, invitationID)
		}
		t.mu.Unlock()
		if !current { // cancelled or rescheduled after firing
			return
		}
		s.locked(func() {
			if err := s.processExpiredInvitation(invitationID); err != nil {
				logf("Error processing expiry for invitation %d: %v", invitationID, err)
			}
		})
	})
	t.timers[invitationID] = timer
}

func (s *Server) cancelInvitationExpiry(invitationID int64) {
	t := s.timers
	t.mu.Lock()
	defer t.mu.Unlock()
	if timer, ok := t.timers[invitationID]; ok {
		timer.Stop()
		delete(t.timers, invitationID)
	}
}

func (s *Server) clearAllTimers() {
	t := s.timers
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, timer := range t.timers {
		timer.Stop()
		delete(t.timers, id)
	}
}

// scheduleExpiryForInvitation (re)schedules the timer of an invited invitation.
func (s *Server) scheduleExpiryForInvitation(invitationID int64) {
	timing, found, err := db.One[invitationTiming](s.db, `
		SELECT inv.status, inv.invited_at, ts.date AS session_date, tslot.start_time
		FROM invitations inv
		JOIN training_sessions ts ON ts.id = inv.session_id
		JOIN timeslots tslot ON tslot.id = inv.timeslot_id
		WHERE inv.id = ? AND inv.status = 'invited'`, invitationID)
	if err != nil {
		logf("schedule expiry for invitation %d: %v", invitationID, err)
		return
	}
	if !found {
		return
	}
	if deadline, ok := invitationDeadline(timing.InvitedAt, timing.SessionDate, timing.StartTime, s.expiryMinutes(), s.clubLocation()); ok {
		s.scheduleInvitationExpiry(invitationID, deadline)
	}
}

func (s *Server) cancelAllSessionTimers(sessionID any) error {
	ids, err := db.Many[int64](s.db, "SELECT id FROM invitations WHERE session_id = ? AND status = 'invited'", sessionID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		s.cancelInvitationExpiry(id)
	}
	return nil
}

// rehydrateTimers schedules timers for every pending invitation (startup, setting changes).
func (s *Server) rehydrateTimers() {
	s.clearAllTimers()
	minutes, loc := s.expiryMinutes(), s.clubLocation()
	type pendingInvitation struct {
		ID int64 `db:"id"`
		invitationTiming
	}
	pending, err := db.Many[pendingInvitation](s.db, `
		SELECT inv.id, inv.status, inv.invited_at, ts.date AS session_date, tslot.start_time
		FROM invitations inv
		JOIN training_sessions ts ON ts.id = inv.session_id
		JOIN timeslots tslot ON tslot.id = inv.timeslot_id
		WHERE inv.status = 'invited'
			AND ts.status NOT IN ('completed', 'cancelled')`)
	if err != nil {
		logf("rehydrate timers: %v", err)
		return
	}
	for _, p := range pending {
		if deadline, ok := invitationDeadline(p.InvitedAt, p.SessionDate, p.StartTime, minutes, loc); ok {
			s.scheduleInvitationExpiry(p.ID, deadline)
		}
	}
	logf("Rehydrated %d invitation expiry timer(s)", len(pending))
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
