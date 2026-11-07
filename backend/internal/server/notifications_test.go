package server

import (
	"fmt"
	"net/http"
	"testing"
)

func TestNotifications(t *testing.T) {
	e := newTestEnv(t)
	sid := e.session(sessionDate, 0)
	for i := range 25 {
		e.srv.CreateNotification(Notification{Type: "invitation_declined", SessionID: sid, StudentName: fmt.Sprintf("S%d", i), SessionDate: sessionDate})
	}

	page := e.admin(http.MethodGet, "/api/notifications", nil).status(http.StatusOK).object()
	if page["total"] != 25.0 || page["page"] != 1.0 || page["limit"] != 20.0 || len(page["notifications"].([]any)) != 20 {
		t.Fatalf("page 1 = total %v page %v limit %v", page["total"], page["page"], page["limit"])
	}
	if first := page["notifications"].([]any)[0].(map[string]any); first["student_name"] != "S24" {
		t.Fatalf("newest first: got %v", first["student_name"])
	}
	page2 := e.admin(http.MethodGet, "/api/notifications?page=2&limit=20", nil).status(http.StatusOK).object()
	if len(page2["notifications"].([]any)) != 5 {
		t.Fatalf("page 2 has %d", len(page2["notifications"].([]any)))
	}
	clamped := e.admin(http.MethodGet, "/api/notifications?page=-3&limit=500", nil).status(http.StatusOK).object()
	if clamped["page"] != 1.0 || clamped["limit"] != 100.0 {
		t.Fatalf("clamped = page %v limit %v", clamped["page"], clamped["limit"])
	}

	unread := func() float64 {
		return e.admin(http.MethodGet, "/api/notifications/unread-count", nil).status(http.StatusOK).object()["count"].(float64)
	}
	if unread() != 25 {
		t.Fatal("all should start unread")
	}
	e.admin(http.MethodPost, "/api/notifications/1/read", nil).status(http.StatusOK)
	if unread() != 24 {
		t.Fatal("mark read")
	}
	e.admin(http.MethodPost, "/api/notifications/abc/read", nil).wantError(http.StatusBadRequest, "Invalid id")
	e.admin(http.MethodPost, "/api/notifications/read-all", nil).status(http.StatusOK)
	if unread() != 0 {
		t.Fatal("read-all")
	}
}

// A zero SessionID is stored as NULL like the other optional fields (it used to be stored as
// 0, which the foreign key rejected, so the notification was silently dropped).
func TestCreateNotificationWithoutSession(t *testing.T) {
	e := newTestEnv(t)
	e.srv.CreateNotification(Notification{Type: "session_full", SessionDate: sessionDate})
	n := e.row("SELECT * FROM notifications")
	if n == nil || n["session_id"] != nil || n["invitation_id"] != nil {
		t.Fatalf("notification = %v, want one with NULL session_id", n)
	}
}

func TestCreateNotificationStoresNulls(t *testing.T) {
	e := newTestEnv(t)
	sid := e.session(sessionDate, 0)
	e.srv.CreateNotification(Notification{Type: "session_full", SessionID: sid, SessionDate: sessionDate})
	n := e.row("SELECT * FROM notifications")
	if n == nil || n["invitation_id"] != nil || n["timeslot_start_time"] != nil || n["student_name"] != "" {
		t.Fatalf("notification = %v", n)
	}
	// An invalid type is logged, not raised.
	e.srv.CreateNotification(Notification{Type: "nonsense", SessionID: sid, SessionDate: sessionDate})
	if len(e.rows("SELECT 1 FROM notifications")) != 1 {
		t.Fatal("invalid notification stored")
	}
}
