package server

import (
	"errors"
	"fmt"
	"net/http"
	"testing"
)

// These tables pin the edge cases of small helpers.

func TestSessionSameTimetable(t *testing.T) {
	zero, three, four := int64(0), int64(3), int64(4)
	for _, tc := range []struct {
		timetable, id *int64
		want          bool
	}{
		{nil, nil, true}, {nil, &zero, false}, {&three, nil, false},
		{&three, &three, true}, {&three, &four, false},
	} {
		if got := (Session{TimetableID: tc.timetable}).sameTimetable(tc.id); got != tc.want {
			t.Errorf("sameTimetable(%v, %v) = %v", tc.timetable, tc.id, got)
		}
	}
}

func TestToInt64(t *testing.T) {
	for _, tc := range []struct {
		in   any
		want int64
	}{
		{int64(5), 5}, {5.9, 5}, {7, 7}, {"12", 12}, {"x", 0}, {nil, 0}, {true, 0},
	} {
		if got := toInt64(tc.in); got != tc.want {
			t.Errorf("toInt64(%#v) = %d", tc.in, got)
		}
	}
}

func TestSQLiteHelpers(t *testing.T) {
	err := errors.New("constraint failed: UNIQUE constraint failed: students.email (2067)")
	if !isUniqueErr(err) || isUniqueErr(nil) || isUniqueErr(errors.New("FOREIGN KEY constraint failed")) {
		t.Error("isUniqueErr")
	}
	if placeholders(0) != "" || placeholders(1) != "?" || placeholders(3) != "?,?,?" {
		t.Error("placeholders")
	}
}

func TestEncodeJSON(t *testing.T) {
	if got := encodeJSON(map[string]any{"html": "<b>&</b>"}); got != `{"html":"<b>&</b>"}` {
		t.Errorf("encodeJSON = %s", got)
	}
}

func TestNewToken(t *testing.T) {
	a, b := newToken(), newToken()
	if a == b || len(a) != 36 || a[14] != '4' || (a[19] != '8' && a[19] != '9' && a[19] != 'a' && a[19] != 'b') {
		t.Fatalf("tokens %s, %s are not distinct UUID v4s", a, b)
	}
}

func TestIsValidTimeZone(t *testing.T) {
	for tz, want := range map[string]bool{"Europe/Amsterdam": true, "UTC": true, "": false, "Local": false, "Nope/Nope": false} {
		if got := isValidTimeZone(tz); got != want {
			t.Errorf("isValidTimeZone(%q) = %v", tz, got)
		}
	}
}

// An {id} that isn't an integer can't name a row, so it gets the resource's usual 404.
func TestPathIDNotAnInteger(t *testing.T) {
	e := newTestEnv(t)
	group := e.group("A")
	timetable, _ := e.timetable("09:00")
	session := e.session("2030-01-01", timetable)
	draft := e.insert("INSERT INTO timetables (name, status) VALUES ('Draft', 'draft') RETURNING id")
	for _, tc := range []struct{ method, path, msg string }{
		{http.MethodGet, "/api/disciplines/abc", "Discipline not found"},
		{http.MethodPut, "/api/groups/1.0", "Group not found"},
		{http.MethodGet, "/api/instructors/x", "Instructor not found"},
		{http.MethodGet, "/api/students/abc", "Student not found"},
		{http.MethodGet, "/api/students/abc/groups", "Student not found"},
		{http.MethodGet, "/api/timetables/abc", "Timetable not found"},
		{http.MethodGet, "/api/sessions/abc", "Training session not found"},
		{http.MethodDelete, "/api/buddy-groups/abc", "Buddy group not found"},
		{http.MethodGet, "/api/sessions/abc/events", "Not found"},
		// Second path ids, behind an existing first one.
		{http.MethodDelete, fmt.Sprintf("/api/groups/%d/members/abc", group), "Student not found"},
		{http.MethodPost, fmt.Sprintf("/api/groups/%d/disciplines/abc", group), "Discipline not found"},
		{http.MethodDelete, fmt.Sprintf("/api/sessions/%d/instructors/abc", session), "Assignment not found"},
		{http.MethodPost, fmt.Sprintf("/api/sessions/%d/invitations/abc/admin-cancel", session), "Invitation not found"},
		{http.MethodDelete, fmt.Sprintf("/api/timetables/%d/timeslots/abc", draft), "Timeslot not found"},
	} {
		e.admin(tc.method, tc.path, map[string]any{}).wantError(http.StatusNotFound, tc.msg)
	}
}
