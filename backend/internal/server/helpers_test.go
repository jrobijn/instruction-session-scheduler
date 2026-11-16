package server

import (
	"database/sql"
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

func TestIsUniqueErr(t *testing.T) {
	conn, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1) // every connection to :memory: is its own database
	if _, err := conn.Exec(`
		CREATE TABLE t (a TEXT UNIQUE, ab TEXT UNIQUE, b INT, c INT, UNIQUE(b, c));
		CREATE TABLE p (x INT, y INT, PRIMARY KEY(x, y));
		INSERT INTO t VALUES ('a', 'ab', 1, 1);
		INSERT INTO p VALUES (1, 1);`); err != nil {
		t.Fatal(err)
	}
	insert := func(q string) error { _, err := conn.Exec(q); return err }
	dupA := insert("INSERT INTO t VALUES ('a', 'x', 2, 2)")
	dupAB := insert("INSERT INTO t VALUES ('x', 'ab', 2, 2)")
	dupBC := insert("INSERT INTO t VALUES ('x', 'y', 1, 1)")
	dupPK := insert("INSERT INTO p VALUES (1, 1)")

	for _, tc := range []struct {
		name    string
		err     error
		columns []string
		want    bool
	}{
		{"single column", dupA, []string{"t.a"}, true},
		{"other column", dupA, []string{"t.ab"}, false},
		{"column name prefix", dupAB, []string{"t.a"}, false},
		{"composite", dupBC, []string{"t.b", "t.c"}, true},
		{"composite subset", dupBC, []string{"t.b"}, false},
		{"composite primary key", dupPK, []string{"p.x", "p.y"}, true},
		{"nil", nil, []string{"t.a"}, false},
		{"untyped error", errors.New("UNIQUE constraint failed: t.a"), []string{"t.a"}, false},
	} {
		if got := isUniqueErr(tc.err, tc.columns...); got != tc.want {
			t.Errorf("%s: isUniqueErr(%v, %v) = %v", tc.name, tc.err, tc.columns, got)
		}
	}
}

func TestPlaceholders(t *testing.T) {
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
		{http.MethodDelete, fmt.Sprintf("/api/groups/%d/members/abc", group), "Member not found"},
		{http.MethodPost, fmt.Sprintf("/api/groups/%d/disciplines/abc", group), "Discipline not found"},
		{http.MethodDelete, fmt.Sprintf("/api/sessions/%d/instructors/abc", session), "Assignment not found"},
		{http.MethodPost, fmt.Sprintf("/api/sessions/%d/invitations/abc/admin-cancel", session), "Invitation not found"},
		{http.MethodDelete, fmt.Sprintf("/api/timetables/%d/timeslots/abc", draft), "Timeslot not found"},
	} {
		e.admin(tc.method, tc.path, map[string]any{}).wantError(http.StatusNotFound, tc.msg)
	}
}
