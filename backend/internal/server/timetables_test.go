package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func timetablePath(id int64, rest ...string) string {
	p := fmt.Sprintf("/api/timetables/%d", id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func TestTimetableLifecycle(t *testing.T) {
	e := newTestEnv(t)
	def := e.group("Default")
	e.exec("UPDATE groups SET is_default = 1 WHERE id = ?", def)
	other := e.group("Other")

	e.admin(http.MethodPost, "/api/timetables", map[string]any{}).wantError(http.StatusBadRequest, "Name is required")
	tt := toInt64(e.admin(http.MethodPost, "/api/timetables", map[string]any{"name": "Winter"}).status(http.StatusCreated).object()["id"])

	got := e.admin(http.MethodGet, timetablePath(tt), nil).status(http.StatusOK).object()
	groups := got["groups"].([]any)
	if got["status"] != "draft" || len(groups) != 1 || groups[0].(map[string]any)["percentage"] != 100.0 {
		t.Fatalf("new timetable = %v, want the default group at 100%%", got)
	}

	e.admin(http.MethodPost, timetablePath(tt, "save"), nil).wantError(http.StatusBadRequest, "Cannot save a timetable with no timeslots")
	e.admin(http.MethodPost, timetablePath(tt, "timeslots"), map[string]any{}).wantError(http.StatusBadRequest, "start_time is required")
	slot := toInt64(e.admin(http.MethodPost, timetablePath(tt, "timeslots"), map[string]any{"start_time": "19:00"}).status(http.StatusCreated).object()["id"])
	e.admin(http.MethodPost, timetablePath(tt, "timeslots"), map[string]any{"start_time": "18:00"}).status(http.StatusCreated)
	e.admin(http.MethodPost, timetablePath(tt, "timeslots"), map[string]any{"start_time": "18:00"}).
		wantError(http.StatusConflict, "A timeslot with this start time already exists in this timetable")
	e.admin(http.MethodDelete, timetablePath(tt, "timeslots", fmt.Sprint(slot)), nil).status(http.StatusOK)
	e.admin(http.MethodDelete, timetablePath(tt, "timeslots", fmt.Sprint(slot)), nil).wantError(http.StatusNotFound, "Timeslot not found")

	e.admin(http.MethodPut, timetablePath(tt, "groups"), map[string]any{}).wantError(http.StatusBadRequest, "groups array is required")
	e.admin(http.MethodPut, timetablePath(tt, "groups"), map[string]any{"groups": []any{
		map[string]any{"group_id": def, "percentage": 60}, map[string]any{"group_id": other, "percentage": 30},
	}}).status(http.StatusOK)
	e.admin(http.MethodPost, timetablePath(tt, "save"), nil).
		wantError(http.StatusBadRequest, "Group percentages must add up to 100% (currently 90%)")
	e.admin(http.MethodPut, timetablePath(tt, "groups"), map[string]any{"groups": []any{
		map[string]any{"group_id": def, "percentage": 60}, map[string]any{"group_id": other, "percentage": 40},
	}}).status(http.StatusOK)
	e.admin(http.MethodPut, timetablePath(tt, "groups", "reorder"), map[string]any{"group_ids": []any{other, def}}).status(http.StatusOK)
	groups = e.admin(http.MethodGet, timetablePath(tt), nil).status(http.StatusOK).object()["groups"].([]any)
	if groups[0].(map[string]any)["group_name"] != "Other" {
		t.Fatalf("groups after reorder = %v", groups)
	}

	e.admin(http.MethodPut, timetablePath(tt), map[string]any{"name": "Winter 2030"}).status(http.StatusOK)
	got = e.admin(http.MethodPost, timetablePath(tt, "save"), nil).status(http.StatusOK).object()
	if got["status"] != "saved" || got["name"] != "Winter 2030" {
		t.Fatalf("saved = %v", got)
	}

	// Saved timetables are frozen.
	e.admin(http.MethodPost, timetablePath(tt, "save"), nil).wantError(http.StatusBadRequest, "Timetable is already saved")
	e.admin(http.MethodPut, timetablePath(tt), map[string]any{"name": "x"}).wantError(http.StatusBadRequest, "Cannot edit a saved timetable")
	e.admin(http.MethodPost, timetablePath(tt, "timeslots"), map[string]any{"start_time": "20:00"}).
		wantError(http.StatusBadRequest, "Cannot modify timeslots of a saved timetable")
	e.admin(http.MethodDelete, timetablePath(tt, "timeslots", "1"), nil).wantError(http.StatusBadRequest, "Cannot modify timeslots of a saved timetable")
	e.admin(http.MethodPut, timetablePath(tt, "groups"), map[string]any{"groups": []any{}}).
		wantError(http.StatusBadRequest, "Cannot modify groups of a saved timetable")
	// Without a name, PUT is a no-op even on a saved timetable.
	e.admin(http.MethodPut, timetablePath(tt), map[string]any{}).status(http.StatusOK)

	list := e.admin(http.MethodGet, "/api/timetables", nil).status(http.StatusOK).array()
	if len(list) != 1 || list[0]["timeslot_count"] != 1.0 {
		t.Fatalf("timetables = %v", list)
	}
	e.admin(http.MethodGet, timetablePath(999), nil).wantError(http.StatusNotFound, "Timetable not found")
}

func TestTimetableSaveRequiresGroups(t *testing.T) {
	e := newTestEnv(t)
	tt := toInt64(e.admin(http.MethodPost, "/api/timetables", map[string]any{"name": "Bare"}).status(http.StatusCreated).object()["id"])
	e.admin(http.MethodPost, timetablePath(tt, "timeslots"), map[string]any{"start_time": "18:00"}).status(http.StatusCreated)
	e.admin(http.MethodPost, timetablePath(tt, "save"), nil).wantError(http.StatusBadRequest, "At least one group must be assigned")
}

func TestTimetableDefaultAndActive(t *testing.T) {
	e := newTestEnv(t)
	a, _ := e.timetable("18:00")
	b, _ := e.timetable("18:00")
	draft := toInt64(e.admin(http.MethodPost, "/api/timetables", map[string]any{"name": "Draft"}).status(http.StatusCreated).object()["id"])
	isDefault := func(id int64) bool {
		return e.row("SELECT is_default FROM timetables WHERE id = ?", id)["is_default"] == int64(1)
	}

	e.admin(http.MethodPost, timetablePath(draft, "set-default"), nil).wantError(http.StatusBadRequest, "Only saved timetables can be set as default")
	e.admin(http.MethodPost, timetablePath(a, "set-default"), nil).status(http.StatusOK)
	e.admin(http.MethodPost, timetablePath(b, "set-default"), nil).status(http.StatusOK)
	if isDefault(a) || !isDefault(b) {
		t.Fatal("only one timetable can be the default")
	}

	// Deactivating the default clears the flag.
	if got := e.admin(http.MethodPost, timetablePath(b, "toggle-active"), nil).status(http.StatusOK).object(); got["active"] != 0.0 {
		t.Fatalf("toggle = %v", got)
	}
	if isDefault(b) {
		t.Fatal("inactive timetable is still the default")
	}
	e.admin(http.MethodPost, timetablePath(b, "set-default"), nil).wantError(http.StatusBadRequest, "Cannot set an inactive timetable as default")
	if got := e.admin(http.MethodPost, timetablePath(b, "toggle-active"), nil).status(http.StatusOK).object(); got["active"] != 1.0 {
		t.Fatalf("toggle back = %v", got)
	}
}

func TestDeleteTimetable(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	f.student("A", f.groupIn("Juniors", 100))
	f.generate().status(http.StatusOK) // the session is now scheduled
	draft := f.session("2030-02-04", f.timetable)

	f.admin(http.MethodDelete, timetablePath(f.timetable), nil).status(http.StatusOK)
	for _, id := range []int64{f.sessionID, draft} {
		s := f.row("SELECT status, timetable_id FROM training_sessions WHERE id = ?", id)
		if s["status"] != "draft" || s["timetable_id"] != nil {
			t.Errorf("session %d after timetable delete = %v", id, s)
		}
	}
	if n := len(f.rows("SELECT 1 FROM invitations")); n != 0 {
		t.Fatalf("%d invitations left", n)
	}
	f.admin(http.MethodDelete, timetablePath(f.timetable), nil).wantError(http.StatusNotFound, "Timetable not found")
}

func TestDeleteTimetableBlockedBySentSessions(t *testing.T) {
	f, _ := invitedPair(t)
	f.admin(http.MethodDelete, timetablePath(f.timetable), nil).
		wantError(http.StatusBadRequest, "Cannot delete: timetable is attached to sessions with sent invitations or completed sessions")
}
