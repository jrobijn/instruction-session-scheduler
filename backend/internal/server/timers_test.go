package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func (e *testEnv) timerCount() int {
	e.srv.timers.mu.Lock()
	defer e.srv.timers.mu.Unlock()
	return len(e.srv.timers.timers)
}

// expire runs the expiry callback the way a firing timer does.
func (e *testEnv) expire(invitationID int64) {
	e.t.Helper()
	var err error
	e.srv.locked(func() { err = e.srv.processExpiredInvitation(invitationID) })
	if err != nil {
		e.t.Fatal(err)
	}
}

func TestExpiredInvitationIsReplaced(t *testing.T) {
	f, _ := invitedPair(t)
	a := f.invitationOf("A")

	f.expire(toInt64(a["id"]))
	if st := f.statusOf("A"); st != "expired" {
		t.Fatalf("A status = %s, want expired", st)
	}
	c := f.invitationOf("C")
	if c["status"] != "invited" || c["slot_id"] != a["slot_id"] || c["timeslot_id"] != a["timeslot_id"] {
		t.Fatalf("replacement = %v", c)
	}
	var log map[string]any
	json.Unmarshal([]byte(c["decision_log"].(string)), &log)
	if log["replacement_reason"] != "invited" {
		t.Fatalf("replacement_reason = %v", log["replacement_reason"])
	}
	if got := f.notificationTypes(); len(got) != 1 || got[0] != "invitation_expired" {
		t.Fatalf("notifications = %v", got)
	}
}

func TestExpiryAfterSlotStartInvalidatesWithoutReplacement(t *testing.T) {
	f, _ := invitedPair(t)
	pinClock(t, utc(sessionDate+" 17:00:00")) // 18:00 in Amsterdam
	f.expire(toInt64(f.invitationOf("A")["id"]))

	if st := f.statusOf("A"); st != "invalidated" {
		t.Fatalf("A status = %s, want invalidated", st)
	}
	if n := len(f.rows("SELECT 1 FROM invitations inv JOIN students s ON s.id = inv.student_id WHERE s.first_name = 'C'")); n != 0 {
		t.Fatal("no replacement should be invited once the slot has started")
	}
}

func TestExpiryIgnoredWhenNoLongerPending(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(f *scheduleFixture)
		want  string
	}{
		{"confirmed", func(f *scheduleFixture) { f.invitationAction("A", "confirm", nil).status(http.StatusOK) }, "confirmed"},
		{"session cancelled", func(f *scheduleFixture) {
			f.exec("UPDATE training_sessions SET status = 'cancelled'")
		}, "invited"},
		{"session completed", func(f *scheduleFixture) {
			f.exec("UPDATE training_sessions SET status = 'completed'")
		}, "invited"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _ := invitedPair(t)
			tc.setup(f)
			f.expire(toInt64(f.invitationOf("A")["id"]))
			if st := f.statusOf("A"); st != tc.want {
				t.Fatalf("status = %s, want %s", st, tc.want)
			}
			for _, n := range f.notificationTypes() {
				if n == "invitation_expired" {
					t.Fatal("expiry notification created")
				}
			}
		})
	}
}

func TestExpiryTimerFires(t *testing.T) {
	f, _ := invitedPair(t)
	id := toInt64(f.invitationOf("A")["id"])
	// Invited long ago: the deadline has passed, so the timer fires right away.
	f.exec("UPDATE invitations SET invited_at = '2000-01-01 00:00:00' WHERE id = ?", id)
	f.srv.locked(func() { f.srv.scheduleExpiryForInvitation(id) })

	deadline := time.Now().Add(5 * time.Second)
	for f.statusOf("A") == "invited" {
		if time.Now().After(deadline) {
			t.Fatal("expiry timer did not fire")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if st := f.statusOf("A"); st != "expired" {
		t.Fatalf("status = %s, want expired", st)
	}
	if f.hasTimer(id) {
		t.Fatal("fired timer still registered")
	}
}

func TestCancelledTimerDoesNotFire(t *testing.T) {
	f, _ := invitedPair(t)
	id := toInt64(f.invitationOf("A")["id"])
	f.srv.scheduleInvitationExpiry(id, time.Now().Add(50*time.Millisecond))
	f.srv.cancelInvitationExpiry(id)
	time.Sleep(150 * time.Millisecond)
	if st := f.statusOf("A"); st != "invited" {
		t.Fatalf("status = %s, want invited", st)
	}
}

func TestRescheduledTimerReplacesOld(t *testing.T) {
	f, _ := invitedPair(t)
	id := toInt64(f.invitationOf("A")["id"])
	f.srv.scheduleInvitationExpiry(id, time.Now().Add(50*time.Millisecond))
	f.srv.scheduleInvitationExpiry(id, time.Now().Add(time.Hour))
	time.Sleep(150 * time.Millisecond)
	if st := f.statusOf("A"); st != "invited" {
		t.Fatalf("status = %s: the replaced timer fired", st)
	}
	if !f.hasTimer(id) {
		t.Fatal("rescheduled timer missing")
	}
}

func TestStartRehydratesPendingTimers(t *testing.T) {
	f, _ := invitedPair(t) // A and B invited
	other := f.session("2030-02-04", f.timetable)
	slot := f.assign(other, f.instructor("Other"))
	c := f.row("SELECT id FROM students WHERE first_name = 'C'")["id"].(int64)
	f.invitation(other, c, f.timeslots[0], slot, 0, "invited")
	f.exec("UPDATE training_sessions SET status = 'cancelled' WHERE id = ?", other)

	f.srv.Stop()
	if n := f.timerCount(); n != 0 {
		t.Fatalf("%d timers after Stop", n)
	}
	f.srv.Start()
	if n := f.timerCount(); n != 2 {
		t.Fatalf("%d timers after Start, want 2 (cancelled sessions are skipped)", n)
	}
}

func TestExpirySettingChangeReschedulesTimers(t *testing.T) {
	f, _ := invitedPair(t)
	id := toInt64(f.invitationOf("A")["id"])
	f.exec("UPDATE invitations SET invited_at = datetime('now', '-30 minutes') WHERE id = ?", id)

	// With a 10 minute window the 30 minute old invitation is overdue and expires at once.
	f.admin(http.MethodPut, "/api/settings/invitation_expiry_minutes", map[string]any{"value": "10"}).status(http.StatusOK)
	deadline := time.Now().Add(5 * time.Second)
	for f.statusOf("A") == "invited" {
		if time.Now().After(deadline) {
			t.Fatal("timer was not rescheduled after the setting changed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if st := f.statusOf("B"); st != "invited" {
		t.Fatalf("B status = %s, want invited", st)
	}
}

func TestSessionCancelClearsTimers(t *testing.T) {
	f, _ := invitedPair(t)
	if n := f.timerCount(); n != 2 {
		t.Fatalf("%d timers, want 2", n)
	}
	f.admin(http.MethodPost, sessionPath(f.sessionID, "cancel"), nil).status(http.StatusOK)
	if n := f.timerCount(); n != 0 {
		t.Fatalf("%d timers after cancelling the session", n)
	}
}
