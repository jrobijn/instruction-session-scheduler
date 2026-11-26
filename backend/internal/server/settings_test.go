package server

import (
	"net/http"
	"testing"
)

func TestSettings(t *testing.T) {
	e := newTestEnv(t)
	all := e.admin(http.MethodGet, "/api/settings", nil).status(http.StatusOK).object()
	if all["club_name"] != "Sports Club" || all["timezone"] != "Europe/Amsterdam" || all["invitation_expiry_minutes"] != "120" || all["slot_number_digits"] != "1" {
		t.Fatalf("settings = %v", all)
	}

	e.admin(http.MethodPut, "/api/settings/club_name", map[string]any{}).wantError(http.StatusBadRequest, "Value is required")
	if got := e.admin(http.MethodPut, "/api/settings/club_name", map[string]any{"value": "Rowing Club"}).status(http.StatusOK).object(); got["value"] != "Rowing Club" {
		t.Fatalf("put = %v", got)
	}

	// Values are strings, also for numeric settings.
	if got := e.admin(http.MethodPut, "/api/settings/invitation_expiry_minutes", map[string]any{"value": "90"}).status(http.StatusOK).object(); got["value"] != "90" {
		t.Fatalf("put number = %v", got)
	}

	e.admin(http.MethodPut, "/api/settings/invitation_expiry_minutes", map[string]any{"value": 90}).wantError(http.StatusBadRequest, "Invalid JSON body")
	e.admin(http.MethodPut, "/api/settings/timezone", map[string]any{"value": "Mars/Base"}).wantError(http.StatusBadRequest, "Invalid time zone")
	e.admin(http.MethodPut, "/api/settings/timezone", map[string]any{"value": "Europe/London"}).status(http.StatusOK)
	if clubLocation(e.srv.db).String() != "Europe/London" {
		t.Fatal("timezone not applied")
	}

	for _, bad := range []string{"", "0", "7", "2.5", "abc"} {
		e.admin(http.MethodPut, "/api/settings/slot_number_digits", map[string]any{"value": bad}).wantError(http.StatusBadRequest, "Slot number digits must be a whole number from 1 to 6")
	}

	if got := e.admin(http.MethodPut, "/api/settings/slot_number_digits", map[string]any{"value": "3"}).status(http.StatusOK).object(); got["value"] != "3" {
		t.Fatalf("put digits = %v", got)
	}
}

func TestSettingRoutesRejectBadInput(t *testing.T) {
	e := newTestEnv(t)
	e.wantRejected(badJSON("PUT", "/api/settings/club_name"))
}
