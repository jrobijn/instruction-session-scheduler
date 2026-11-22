package server

import (
	"log"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
)

// The timer functions below require s.mu to be held; timer callbacks take it themselves.

func (s *Server) scheduleInvitationExpiry(invitationID int64, at time.Time) {
	s.cancelInvitationExpiry(invitationID)
	var timer *time.Timer
	timer = time.AfterFunc(max(0, time.Until(at)), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		// Stop can't stop a callback that already fired, so skip if this timer was
		// cancelled or rescheduled while waiting for the lock.
		if s.timers[invitationID] != timer {
			return
		}
		delete(s.timers, invitationID)
		if err := s.inTx(func(t *txn) error { return t.expireInvitation(invitationID) }); err != nil {
			log.Printf("Error processing expiry for invitation %d: %v", invitationID, err)
		}
	})
	s.timers[invitationID] = timer
}

func (s *Server) cancelInvitationExpiry(invitationID int64) {
	if timer, ok := s.timers[invitationID]; ok {
		timer.Stop()
		delete(s.timers, invitationID)
	}
}

func (s *Server) clearAllTimers() {
	for id, timer := range s.timers {
		timer.Stop()
		delete(s.timers, id)
	}
}

// rehydrateTimers schedules timers for every pending invitation (startup, setting changes).
func (s *Server) rehydrateTimers() {
	s.clearAllTimers()
	minutes, loc := expiryMinutes(s.db), clubLocation(s.db)
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
		log.Printf("rehydrate timers: %v", err)
		return
	}
	for _, p := range pending {
		if deadline, ok := invitationDeadline(p.InvitedAt, p.SessionDate, p.StartTime, minutes, loc); ok {
			s.scheduleInvitationExpiry(p.ID, deadline)
		}
	}
	log.Printf("Rehydrated %d invitation expiry timer(s)", len(pending))
}
