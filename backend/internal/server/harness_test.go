package server

// Test harness for the server package: every test gets its own migrated SQLite database and
// a Server behind its real HTTP handler. Fixtures are inserted with SQL so tests state exactly
// the rows they depend on; requests go through the full stack (auth, routing, handlers).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/auth"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/config"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/sse"
)

const (
	testAdminPassword = "test-password"
	testJWTSecret     = "test-jwt-secret"
)

type testEnv struct {
	t       *testing.T
	srv     *Server
	db      *db.DB
	handler http.Handler
	cookie  *http.Cookie

	// counters for unique fixture values
	students, instructors, groups, disciplines int

	mailMu sync.Mutex
	mail   []sentEmail
}

type sentEmail struct {
	To, Subject, Text, HTML string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := d.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}

	cfg := config.Config{
		AdminPassword: testAdminPassword,
		JWTSecret:     testJWTSecret,
		FrontendURL:   "http://frontend.test",
		PublicDir:     t.TempDir(),
	}
	e := &testEnv{t: t, db: d}
	mailer := email.NewCapturing(email.Config{FrontendURL: cfg.FrontendURL}, func(to, subject, text, html string) {
		e.mailMu.Lock()
		defer e.mailMu.Unlock()
		e.mail = append(e.mail, sentEmail{to, subject, text, html})
	})
	e.srv = New(cfg, d, sse.NewHub(), mailer)
	e.handler = e.srv.Handler()
	t.Cleanup(e.srv.Stop)

	token, err := auth.Sign(testJWTSecret, "admin", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	e.cookie = &http.Cookie{Name: authCookie, Value: token}
	return e
}

// sentMail returns the emails sent so far.
func (e *testEnv) sentMail() []sentEmail {
	e.mailMu.Lock()
	defer e.mailMu.Unlock()
	return append([]sentEmail(nil), e.mail...)
}

// mailTo returns the emails sent to an address.
func (e *testEnv) mailTo(addr string) []sentEmail {
	var out []sentEmail
	for _, m := range e.sentMail() {
		if m.To == addr {
			out = append(out, m)
		}
	}
	return out
}

// pinClock makes nowFunc return t for the rest of the test. Tests that use it must not run
// in parallel. Timers still run on the real clock.
func pinClock(t *testing.T, now time.Time) {
	t.Helper()
	prev := nowFunc
	nowFunc = func() time.Time { return now }
	t.Cleanup(func() { nowFunc = prev })
}

// --- requests ---------------------------------------------------------------------------

type response struct {
	t    *testing.T
	Code int
	Body []byte
	rec  *httptest.ResponseRecorder
}

func (e *testEnv) request(method, path string, body any, withAuth bool) *response {
	e.t.Helper()
	var reader *bytes.Reader
	switch b := body.(type) {
	case nil:
		reader = bytes.NewReader(nil)
	case string:
		reader = bytes.NewReader([]byte(b))
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if withAuth {
		req.AddCookie(e.cookie)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return &response{t: e.t, Code: rec.Code, Body: rec.Body.Bytes(), rec: rec}
}

// admin sends an authenticated request; public sends one without the auth cookie.
func (e *testEnv) admin(method, path string, body any) *response {
	e.t.Helper()
	return e.request(method, path, body, true)
}

func (e *testEnv) public(method, path string, body any) *response {
	e.t.Helper()
	return e.request(method, path, body, false)
}

func (r *response) status(want int) *response {
	r.t.Helper()
	if r.Code != want {
		r.t.Fatalf("status = %d, want %d; body: %s", r.Code, want, r.Body)
	}
	return r
}

func (r *response) object() map[string]any {
	r.t.Helper()
	var v map[string]any
	if err := json.Unmarshal(r.Body, &v); err != nil {
		r.t.Fatalf("decode object: %v; body: %s", err, r.Body)
	}
	return v
}

func (r *response) array() []map[string]any {
	r.t.Helper()
	var v []map[string]any
	if err := json.Unmarshal(r.Body, &v); err != nil {
		r.t.Fatalf("decode array: %v; body: %s", err, r.Body)
	}
	return v
}

// wantError asserts an error response with the given status and message.
func (r *response) wantError(status int, msg string) {
	r.t.Helper()
	r.status(status)
	if got := r.object()["error"]; got != msg {
		r.t.Fatalf("error = %q, want %q", got, msg)
	}
}

// --- database ---------------------------------------------------------------------------

// exec runs a statement and returns the last inserted id.
func (e *testEnv) exec(query string, args ...any) int64 {
	e.t.Helper()
	res, err := e.db.Exec(query, args...)
	if err != nil {
		e.t.Fatalf("exec %q: %v", query, err)
	}
	return lastID(res)
}

func (e *testEnv) rows(query string, args ...any) []map[string]any {
	e.t.Helper()
	rows, err := db.All(e.db, query, args...)
	if err != nil {
		e.t.Fatalf("query %q: %v", query, err)
	}
	return rows
}

func (e *testEnv) row(query string, args ...any) map[string]any {
	e.t.Helper()
	row, err := db.Get(e.db, query, args...)
	if err != nil {
		e.t.Fatalf("query %q: %v", query, err)
	}
	return row
}

func (e *testEnv) setSetting(key, value string) {
	e.t.Helper()
	e.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
}

// --- fixtures ---------------------------------------------------------------------------

// group creates a group with one active discipline, so its members are schedulable.
func (e *testEnv) group(name string) int64 {
	e.t.Helper()
	e.groups++
	gid := e.exec("INSERT INTO groups (name, color) VALUES (?, ?)", name, fmt.Sprintf("#00000%d", e.groups%10))
	e.discipline(name+" discipline", gid)
	return gid
}

// discipline creates an active discipline linked to the given groups.
func (e *testEnv) discipline(name string, groupIDs ...int64) int64 {
	e.t.Helper()
	e.disciplines++
	did := e.exec("INSERT INTO disciplines (name, abbreviation) VALUES (?, ?)", name, fmt.Sprintf("D%d", e.disciplines))
	for _, gid := range groupIDs {
		e.exec("INSERT INTO discipline_groups (discipline_id, group_id) VALUES (?, ?)", did, gid)
	}
	return did
}

// student creates an active student in the group. joined_at increases with every student,
// so with the default 'back' new-member policy, creation order is queue order.
func (e *testEnv) student(firstName string, groupID int64) int64 {
	e.t.Helper()
	e.students++
	sid := e.exec("INSERT INTO students (first_name, last_name, email) VALUES (?, ?, ?)",
		firstName, "Test", fmt.Sprintf("%s.%d@example.test", strings.ToLower(firstName), e.students))
	joined := time.Date(2029, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(e.students) * time.Minute)
	e.exec("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, ?)", sid, groupID, joined.Format(time.DateTime))
	return sid
}

func (e *testEnv) studentEmail(id int64) string {
	e.t.Helper()
	return e.row("SELECT email FROM students WHERE id = ?", id)["email"].(string)
}

func (e *testEnv) instructor(lastName string) int64 {
	e.t.Helper()
	e.instructors++
	return e.exec("INSERT INTO instructors (first_name, last_name, email) VALUES (?, ?, ?)",
		"Instructor", lastName, fmt.Sprintf("instructor%d@example.test", e.instructors))
}

// timetable creates a saved timetable with the given start times; it returns the timetable
// id and the timeslot ids in the order given.
func (e *testEnv) timetable(startTimes ...string) (int64, []int64) {
	e.t.Helper()
	tt := e.exec("INSERT INTO timetables (name, status) VALUES ('Timetable', 'saved')")
	ids := make([]int64, len(startTimes))
	for i, st := range startTimes {
		ids[i] = e.exec("INSERT INTO timeslots (timetable_id, start_time) VALUES (?, ?)", tt, st)
	}
	return tt, ids
}

// timetableGroup links a group to a timetable; position follows call order.
func (e *testEnv) timetableGroup(timetableID, groupID int64, percentage int) {
	e.t.Helper()
	e.exec(`INSERT INTO timetable_groups (timetable_id, group_id, percentage, position)
		VALUES (?, ?, ?, (SELECT COUNT(*) FROM timetable_groups WHERE timetable_id = ?))`,
		timetableID, groupID, percentage, timetableID)
}

// session creates a draft training session; timetableID 0 means none.
func (e *testEnv) session(date string, timetableID int64) int64 {
	e.t.Helper()
	dow, ok := dayOfWeek(date)
	if !ok {
		e.t.Fatalf("bad date %q", date)
	}
	var tt any
	if timetableID != 0 {
		tt = timetableID
	}
	return e.exec("INSERT INTO training_sessions (date, day_of_week, timetable_id) VALUES (?, ?, ?)", date, dow, tt)
}

// assign adds an instructor to a session and returns the slot id.
func (e *testEnv) assign(sessionID, instructorID int64) int64 {
	e.t.Helper()
	return e.exec("INSERT INTO session_slots (session_id, instructor_id) VALUES (?, ?)", sessionID, instructorID)
}

// invitation inserts an invitation directly; groupID 0 makes it a manual one (group_id NULL).
func (e *testEnv) invitation(sessionID, studentID, timeslotID, slotID, groupID int64, status string) int64 {
	e.t.Helper()
	var gid any
	if groupID != 0 {
		gid = groupID
	}
	return e.exec(`INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token, group_id, status)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, sessionID, studentID, timeslotID, slotID, newToken(), gid, status)
}

func (e *testEnv) preferTimeslots(studentID, timetableID int64, timeslotIDs ...int64) {
	e.t.Helper()
	for _, ts := range timeslotIDs {
		e.exec("INSERT INTO student_preferred_timeslots (student_id, timeslot_id, timetable_id) VALUES (?, ?, ?)", studentID, ts, timetableID)
	}
}

func (e *testEnv) buddies(studentIDs ...int64) int64 {
	e.t.Helper()
	bg := e.exec("INSERT INTO buddy_groups DEFAULT VALUES")
	for _, sid := range studentIDs {
		e.exec("INSERT INTO buddy_group_members (buddy_group_id, student_id) VALUES (?, ?)", bg, sid)
	}
	return bg
}
