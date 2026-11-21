package server

import (
	"net/http"
	"testing"
)

func TestNotifications(t *testing.T) {
	e := newTestEnv(t)
	sid := e.session(sessionDate, 0)
	for range 25 {
		e.srv.notifySession("session_full", sid, sessionDate)
	}

	page := e.admin(http.MethodGet, "/api/notifications", nil).status(http.StatusOK).object()
	if page["total"] != 25.0 || page["page"] != 1.0 || page["limit"] != 20.0 || len(page["notifications"].([]any)) != 20 {
		t.Fatalf("page 1 = total %v page %v limit %v", page["total"], page["page"], page["limit"])
	}
	if first := page["notifications"].([]any)[0].(map[string]any); first["id"] != 25.0 {
		t.Fatalf("newest first: got id %v", first["id"])
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
	e.admin(http.MethodPost, "/api/notifications/1/read", nil).status(http.StatusOK) // already read
	e.admin(http.MethodPost, "/api/notifications/abc/read", nil).wantError(http.StatusNotFound, "Notification not found")
	e.admin(http.MethodPost, "/api/notifications/999999/read", nil).wantError(http.StatusNotFound, "Notification not found")
	e.admin(http.MethodPost, "/api/notifications/read-all", nil).status(http.StatusOK)
	if unread() != 0 {
		t.Fatal("read-all")
	}
}

func TestNotifyInvitationStoresInvitationDetails(t *testing.T) {
	f, _ := invitedPair(t)
	invID := toInt64(f.invitationOf("A")["id"])
	inv, _, err := invitationByID(f.srv.db, invID)
	if err != nil {
		t.Fatal(err)
	}
	f.srv.notifyInvitation("invitation_declined", inv)
	n := f.row("SELECT * FROM notifications")
	if n == nil || toInt64(n["invitation_id"]) != invID || toInt64(n["session_id"]) != f.sessionID ||
		n["student_name"] != "A Test" || n["session_date"] != sessionDate || n["timeslot_start_time"] != "18:00" {
		t.Fatalf("notification = %v", n)
	}
}

func TestNotifySessionStoresNulls(t *testing.T) {
	e := newTestEnv(t)
	sid := e.session(sessionDate, 0)
	e.srv.notifySession("session_full", sid, sessionDate)
	n := e.row("SELECT * FROM notifications")
	if n == nil || n["invitation_id"] != nil || n["timeslot_start_time"] != nil || n["student_name"] != "" {
		t.Fatalf("notification = %v", n)
	}
	// An invalid type is logged, not raised.
	e.srv.notifySession("nonsense", sid, sessionDate)
	if len(e.rows("SELECT 1 FROM notifications")) != 1 {
		t.Fatal("invalid notification stored")
	}
}
