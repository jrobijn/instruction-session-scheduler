package server

import (
	"net/http"
	"testing"
)

func TestSettings(t *testing.T) {
	e := newTestEnv(t)
	all := e.admin(http.MethodGet, "/api/settings", nil).status(http.StatusOK).object()
	if all["club_name"] != "Sports Club" || all["timezone"] != "Europe/Amsterdam" || all["invitation_expiry_minutes"] != "120" {
		t.Fatalf("settings = %v", all)
	}
	e.admin(http.MethodPut, "/api/settings/club_name", map[string]any{}).wantError(http.StatusBadRequest, "Value is required")
	if got := e.admin(http.MethodPut, "/api/settings/club_name", map[string]any{"value": "Rowing Club"}).status(http.StatusOK).object(); got["value"] != "Rowing Club" {
		t.Fatalf("put = %v", got)
	}
	// Numbers are stored the way String() renders them.
	if got := e.admin(http.MethodPut, "/api/settings/invitation_expiry_minutes", map[string]any{"value": 90}).status(http.StatusOK).object(); got["value"] != "90" {
		t.Fatalf("put number = %v", got)
	}
	e.admin(http.MethodPut, "/api/settings/timezone", map[string]any{"value": "Mars/Base"}).wantError(http.StatusBadRequest, "Invalid time zone")
	e.admin(http.MethodPut, "/api/settings/timezone", map[string]any{"value": "Europe/London"}).status(http.StatusOK)
	if e.srv.clubLocation().String() != "Europe/London" {
		t.Fatal("timezone not applied")
	}
}
