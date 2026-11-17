package server

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These tables pin the edge cases of small helpers.

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

func TestEncodeJSON(t *testing.T) {
	if got := encodeJSON(map[string]any{"html": "<b>&</b>"}); got != `{"html":"<b>&</b>"}` {
		t.Errorf("encodeJSON = %s", got)
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

func TestDecode(t *testing.T) {
	type body struct {
		A int `json:"a"`
	}
	post := func(s string) *http.Request { return httptest.NewRequest(http.MethodPost, "/", strings.NewReader(s)) }

	if v, err := decode[body](post(`{"a":1}`)); err != nil || v.A != 1 {
		t.Fatalf("decode = %v, %v", v, err)
	}
	for name, tc := range map[string]struct{ body, want string }{
		"empty":      {"", "Invalid JSON body"},
		"malformed":  {"{", "Invalid JSON body"},
		"wrong type": {`{"a":"x"}`, "Invalid JSON body"},
		"too large":  {`{"b":"` + strings.Repeat("x", 1<<20) + `"}`, "Invalid JSON body"},
	} {
		if _, err := decode[body](post(tc.body)); err == nil || err.Error() != tc.want {
			t.Errorf("%s: err = %v, want %q", name, err, tc.want)
		}
	}
}
