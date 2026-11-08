package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func studentPath(id int64, rest ...string) string {
	p := fmt.Sprintf("/api/students/%d", id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func TestCreateStudent(t *testing.T) {
	e := newTestEnv(t)
	e.admin(http.MethodPost, "/api/students", map[string]any{"first_name": "A", "last_name": "B"}).
		wantError(http.StatusBadRequest, "First name, last name and email are required")

	got := e.admin(http.MethodPost, "/api/students", map[string]any{"first_name": "Ann", "last_name": "Lee", "email": "ann@example.test"}).
		status(http.StatusCreated).object()
	if got["membership_id"] != "" || got["active"] != 1.0 || got["preferred_days"] != "0|1|2|3|4|5|6" {
		t.Fatalf("created = %v", got)
	}
	got = e.admin(http.MethodPost, "/api/students", map[string]any{"first_name": "Cy", "last_name": "Lee", "email": "cy@example.test", "preferred_days": "1|3"}).
		status(http.StatusCreated).object()
	if got["preferred_days"] != "1|3" {
		t.Fatalf("preferred_days = %v, want 1|3", got["preferred_days"])
	}
	if n := len(e.rows("SELECT 1 FROM student_groups")); n != 0 {
		t.Fatal("student added to a group without a default group")
	}

	e.admin(http.MethodPost, "/api/students", map[string]any{"first_name": "X", "last_name": "Y", "email": "ann@example.test"}).
		wantError(http.StatusConflict, "A student with this email already exists")

	// New students join the default group.
	g := e.group("Default")
	e.exec("UPDATE groups SET is_default = 1 WHERE id = ?", g)
	got = e.admin(http.MethodPost, "/api/students", map[string]any{"first_name": "Bo", "last_name": "Ng", "email": "bo@example.test", "membership_id": "M-1"}).
		status(http.StatusCreated).object()
	if got["membership_id"] != "M-1" {
		t.Fatalf("membership_id = %v", got["membership_id"])
	}
	m := e.row("SELECT * FROM student_groups WHERE student_id = ?", toInt64(got["id"]))
	if m == nil || toInt64(m["group_id"]) != g || m["joined_at"] == nil {
		t.Fatalf("membership = %v", m)
	}
}

func TestListAndGetStudents(t *testing.T) {
	e := newTestEnv(t)
	g := e.group("Juniors")
	zed := e.student("Zed", g)
	amy := e.student("Amy", g)
	e.exec("UPDATE students SET last_name = 'Alpha' WHERE id = ?", zed)
	loner := e.exec("INSERT INTO students (first_name, last_name, email) VALUES ('Lo', 'Ner', 'lo@example.test')")
	gone := e.student("Gone", g)
	e.buddies(zed, amy, gone)
	e.exec("UPDATE students SET deleted_at = datetime('now') WHERE id = ?", gone)

	list := e.admin(http.MethodGet, "/api/students", nil).status(http.StatusOK).array()
	var names []string
	for _, s := range list {
		names = append(names, s["first_name"].(string))
	}
	if strings.Join(names, ",") != "Zed,Lo,Amy" { // by last name: Alpha, Ner, Test
		t.Fatalf("students = %v", names)
	}
	if grp := list[0]["group"].(map[string]any); grp["name"] != "Juniors" {
		t.Errorf("group = %v", grp)
	}
	if bg := list[0]["buddy_group"].(map[string]any); bg["name"] != "Zed & Amy" {
		t.Errorf("buddy_group name = %v, want deleted members left out", bg["name"])
	}
	if list[1]["group"] != nil || list[1]["buddy_group"] != nil {
		t.Errorf("student without group = %v", list[1])
	}

	if got := e.admin(http.MethodGet, studentPath(loner), nil).status(http.StatusOK).object(); got["first_name"] != "Lo" {
		t.Fatalf("get = %v", got)
	}
	e.admin(http.MethodGet, studentPath(gone), nil).wantError(http.StatusNotFound, "Student not found")
}

func TestUpdateStudent(t *testing.T) {
	e := newTestEnv(t)
	g := e.group("Juniors")
	s := e.student("Ann", g)
	other := e.student("Bob", g)

	got := e.admin(http.MethodPut, studentPath(s), map[string]any{"last_name": "Smith", "preferred_days": "1|3"}).status(http.StatusOK).object()
	if got["first_name"] != "Ann" || got["last_name"] != "Smith" || got["preferred_days"] != "1|3" {
		t.Fatalf("updated = %v", got)
	}
	e.admin(http.MethodPut, studentPath(s), map[string]any{"email": e.studentEmail(other)}).
		wantError(http.StatusConflict, "A student with this email already exists")
	e.admin(http.MethodPut, studentPath(999), map[string]any{}).wantError(http.StatusNotFound, "Student not found")

	// Deactivating keeps the queue position; reactivating records reactivated_at.
	e.admin(http.MethodPut, studentPath(s), map[string]any{"active": 0}).status(http.StatusOK)
	if e.row("SELECT reactivated_at FROM student_groups WHERE student_id = ?", s)["reactivated_at"] != nil {
		t.Fatal("deactivation set reactivated_at")
	}
	e.admin(http.MethodPut, studentPath(s), map[string]any{"active": 1}).status(http.StatusOK)
	if e.row("SELECT reactivated_at FROM student_groups WHERE student_id = ?", s)["reactivated_at"] == nil {
		t.Fatal("reactivation did not set reactivated_at")
	}
}

func TestDeleteStudent(t *testing.T) {
	f, g := invitedPair(t) // A invited at 18:00, B invited at 19:00
	a, b := f.studentID("A"), f.studentID("B")
	aEmail, bEmail := f.studentEmail(a), f.studentEmail(b)
	aInv := toInt64(f.invitationOf("A")["id"])
	f.invitationAction("B", "confirm", nil).status(http.StatusOK)

	// A also has an unsent invitation for a later session and a confirmed one for a past,
	// completed session.
	later := f.session("2030-02-04", f.timetable)
	f.invitation(later, a, f.timeslots[0], f.assign(later, f.instructor("Later")), g, "scheduled")
	past := f.session("2029-06-01", f.timetable)
	pastInv := f.invitation(past, a, f.timeslots[0], f.assign(past, f.instructor("Past")), g, "confirmed")
	f.exec("UPDATE training_sessions SET status = 'completed' WHERE id = ?", past)
	mailA, mailB := len(f.mailTo(aEmail)), len(f.mailTo(bEmail))

	f.admin(http.MethodDelete, studentPath(a), nil).status(http.StatusOK)
	row := f.row("SELECT active, deleted_at FROM students WHERE id = ?", a)
	if row["active"] != int64(0) || row["deleted_at"] == nil {
		t.Fatalf("deleted student = %v", row)
	}
	statuses := map[int64]string{}
	for _, r := range f.rows("SELECT session_id, status FROM invitations WHERE student_id = ?", a) {
		statuses[toInt64(r["session_id"])] = r["status"].(string)
	}
	want := map[int64]string{f.sessionID: "admin_cancelled", later: "admin_cancelled", past: "confirmed"}
	for sid, st := range want {
		if statuses[sid] != st {
			t.Errorf("invitation for session %d = %s, want %s", sid, statuses[sid], st)
		}
	}
	if f.row("SELECT status FROM invitations WHERE id = ?", pastInv)["status"] != "confirmed" {
		t.Error("completed session history was changed")
	}
	if f.hasTimer(aInv) {
		t.Error("expiry timer of the cancelled invitation still set")
	}
	// Only the emailed invitation triggers a cancellation email; no replacement is invited.
	if n := len(f.mailTo(aEmail)) - mailA; n != 1 {
		t.Errorf("A got %d cancellation emails, want 1", n)
	}
	if n := len(f.rows("SELECT 1 FROM invitations WHERE session_id = ?", f.sessionID)); n != 2 {
		t.Errorf("%d invitations in the session, want 2 (no replacement)", n)
	}
	f.admin(http.MethodDelete, studentPath(a), nil).wantError(http.StatusNotFound, "Student not found")

	// A confirmed invitation is cancelled too, and the student is told.
	f.admin(http.MethodDelete, studentPath(b), nil).status(http.StatusOK)
	if st := f.statusOf("B"); st != "admin_cancelled" {
		t.Fatalf("B's invitation = %s, want admin_cancelled", st)
	}
	if n := len(f.mailTo(bEmail)) - mailB; n != 1 {
		t.Errorf("B got %d cancellation emails, want 1", n)
	}
}

// Documents current behaviour: a soft-deleted student's email stays taken, so the student
// cannot be added again, even though they no longer appear anywhere.
func TestDeletedStudentEmailCannotBeReused(t *testing.T) {
	e := newTestEnv(t)
	s := e.student("Ann", e.group("Juniors"))
	addr := e.studentEmail(s)
	e.admin(http.MethodDelete, studentPath(s), nil).status(http.StatusOK)

	e.admin(http.MethodPost, "/api/students", map[string]any{"first_name": "Ann", "last_name": "Test", "email": addr}).
		wantError(http.StatusConflict, "A student with this email already exists")
	res := e.admin(http.MethodPost, "/api/students/import", map[string]any{"csv": "first_name,last_name,email\nAnn,Test," + addr}).status(http.StatusOK).object()
	if res["imported"] != 0.0 || res["errors"].([]any)[0] != "Row 2: UNIQUE constraint failed: students.email" {
		t.Fatalf("import = %v", res)
	}
}

func TestStudentInvitationLists(t *testing.T) {
	f, _ := invitedPair(t)
	a := f.studentID("A")
	f.invitationAction("A", "decline", nil).status(http.StatusOK)
	past := f.session("2029-06-01", f.timetable)
	f.invitation(past, a, f.timeslots[0], f.assign(past, f.instructor("Past")), 0, "confirmed")
	f.exec("UPDATE training_sessions SET status = 'completed' WHERE id = ?", past)
	upcoming := f.session("2030-02-04", f.timetable)
	f.invitation(upcoming, a, f.timeslots[1], f.assign(upcoming, f.instructor("Next")), 0, "invited")

	active := f.admin(http.MethodGet, studentPath(a, "invitations"), nil).status(http.StatusOK).array()
	if len(active) != 1 || active[0]["session_date"] != "2030-02-04" || active[0]["start_time"] != "19:00" {
		t.Fatalf("active invitations = %v", active)
	}
	history := f.admin(http.MethodGet, studentPath(a, "invitation-history"), nil).status(http.StatusOK).array()
	if len(history) != 3 {
		t.Fatalf("history = %v", history)
	}
	f.admin(http.MethodGet, studentPath(999, "invitations"), nil).wantError(http.StatusNotFound, "Student not found")
	f.admin(http.MethodGet, studentPath(999, "invitation-history"), nil).wantError(http.StatusNotFound, "Student not found")
}

func TestStudentPreferredTimeslots(t *testing.T) {
	e := newTestEnv(t)
	s := e.student("Ann", e.group("Juniors"))
	tt, slots := e.timetable("18:00", "19:00", "20:00")
	other, otherSlots := e.timetable("09:00", "10:00")
	path := func(timetable int64) string { return studentPath(s, "preferred-timeslots", fmt.Sprint(timetable)) }
	stored := func(timetable int64) int {
		return len(e.rows("SELECT 1 FROM student_preferred_timeslots WHERE student_id = ? AND timetable_id = ?", s, timetable))
	}

	e.admin(http.MethodPut, path(tt), map[string]any{}).wantError(http.StatusBadRequest, "timeslot_ids array is required")
	e.admin(http.MethodPut, path(999), map[string]any{"timeslot_ids": []any{}}).wantError(http.StatusNotFound, "Timetable not found")
	e.admin(http.MethodPut, studentPath(999, "preferred-timeslots", fmt.Sprint(tt)), map[string]any{"timeslot_ids": []any{}}).
		wantError(http.StatusNotFound, "Student not found")

	// Ids of other timetables are ignored.
	e.admin(http.MethodPut, path(tt), map[string]any{"timeslot_ids": []any{slots[0], otherSlots[0]}}).status(http.StatusOK)
	if n := stored(tt); n != 1 {
		t.Fatalf("stored %d preferences, want 1", n)
	}
	e.admin(http.MethodPut, path(other), map[string]any{"timeslot_ids": []any{otherSlots[1]}}).status(http.StatusOK)

	got := e.admin(http.MethodGet, studentPath(s, "preferred-timeslots"), nil).status(http.StatusOK).object()
	if fmt.Sprint(got[fmt.Sprint(tt)]) != fmt.Sprint([]any{float64(slots[0])}) || fmt.Sprint(got[fmt.Sprint(other)]) != fmt.Sprint([]any{float64(otherSlots[1])}) {
		t.Fatalf("preferences = %v", got)
	}

	// Choosing every timeslot means no preference.
	e.admin(http.MethodPut, path(tt), map[string]any{"timeslot_ids": []any{slots[0], slots[1], slots[2]}}).status(http.StatusOK)
	if n := stored(tt); n != 0 {
		t.Fatalf("stored %d preferences for 'all', want 0", n)
	}
	if n := stored(other); n != 1 {
		t.Fatal("updating one timetable changed another")
	}
}

// "All timeslots" is decided by the valid ids sent, not by how many ids were sent: invalid,
// foreign and duplicate ids must not make a partial selection look complete.
func TestStudentPreferredTimeslotsIgnoresInvalidIDsWhenCounting(t *testing.T) {
	e := newTestEnv(t)
	s := e.student("Ann", e.group("Juniors"))
	tt, slots := e.timetable("18:00", "19:00", "20:00")
	_, otherSlots := e.timetable("09:00")
	path := studentPath(s, "preferred-timeslots", fmt.Sprint(tt))
	stored := func() []string {
		var out []string
		for _, r := range e.rows(`SELECT t.start_time FROM student_preferred_timeslots p
			JOIN timeslots t ON t.id = p.timeslot_id WHERE p.student_id = ? ORDER BY t.start_time`, s) {
			out = append(out, r["start_time"].(string))
		}
		return out
	}

	for name, ids := range map[string][]any{
		"invalid ids":   {slots[0], 9999, -1},
		"foreign id":    {slots[0], otherSlots[0], 9999},
		"duplicate ids": {slots[0], slots[0], slots[0]},
	} {
		t.Run(name, func(t *testing.T) {
			e.admin(http.MethodPut, path, map[string]any{"timeslot_ids": ids}).status(http.StatusOK)
			if got := strings.Join(stored(), ","); got != "18:00" {
				t.Fatalf("stored %q, want only 18:00", got)
			}
		})
	}

	// Ids must be numbers.
	e.admin(http.MethodPut, path, map[string]any{"timeslot_ids": []any{slots[0], "x"}}).
		wantError(http.StatusBadRequest, "Invalid value for timeslot_ids")

	// Two of three plus an invalid id is still a partial selection.
	e.admin(http.MethodPut, path, map[string]any{"timeslot_ids": []any{slots[0], slots[2], 9999}}).status(http.StatusOK)
	if got := strings.Join(stored(), ","); got != "18:00,20:00" {
		t.Fatalf("stored %q", got)
	}
	// Every valid id (with noise) still means no preference.
	e.admin(http.MethodPut, path, map[string]any{"timeslot_ids": []any{slots[2], slots[1], 9999, slots[0]}}).status(http.StatusOK)
	if got := stored(); len(got) != 0 {
		t.Fatalf("stored %q, want none for all timeslots", got)
	}
}

func TestStudentGroupMembership(t *testing.T) {
	e := newTestEnv(t)
	a, b := e.group("A"), e.group("B")
	s := e.student("Ann", a)

	got := e.admin(http.MethodGet, studentPath(s, "groups"), nil).status(http.StatusOK).object()
	if toInt64(got["id"]) != a || got["name"] != "A" {
		t.Fatalf("group = %v", got)
	}
	e.admin(http.MethodPut, studentPath(s, "groups"), map[string]any{"group_id": b}).status(http.StatusOK)
	if m := e.rows("SELECT group_id FROM student_groups WHERE student_id = ?", s); len(m) != 1 || toInt64(m[0]["group_id"]) != b {
		t.Fatalf("memberships = %v", m)
	}
	e.admin(http.MethodPut, studentPath(s, "groups"), map[string]any{"group_id": nil}).status(http.StatusOK)
	if string(e.admin(http.MethodGet, studentPath(s, "groups"), nil).status(http.StatusOK).Body) != "null\n" {
		t.Fatal("student without group should return null")
	}
	e.admin(http.MethodPut, studentPath(999, "groups"), map[string]any{}).wantError(http.StatusNotFound, "Student not found")
}

func TestStudentCooldown(t *testing.T) {
	e := newTestEnv(t)
	s := e.student("Ann", e.group("Juniors"))
	path := studentPath(s, "cooldown")

	for _, days := range []any{0, -1, nil} {
		e.admin(http.MethodPut, path, map[string]any{"days": days}).wantError(http.StatusBadRequest, "A positive number of days is required")
	}
	e.admin(http.MethodPut, path, map[string]any{"days": "3"}).wantError(http.StatusBadRequest, "Invalid value for days")
	before := time.Now().UTC()
	got := e.admin(http.MethodPut, path, map[string]any{"days": 2}).status(http.StatusOK).object()
	until, err := time.Parse(time.DateTime, got["cooldown_until"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if want := before.Add(48 * time.Hour); until.Before(want.Add(-2*time.Second)) || until.After(want.Add(2*time.Second)) {
		t.Fatalf("cooldown_until = %v, want about %v", until, want)
	}

	// Ending the cooldown sets it to now rather than clearing it.
	got = e.admin(http.MethodDelete, path, nil).status(http.StatusOK).object()
	ended, _ := time.Parse(time.DateTime, got["cooldown_until"].(string))
	if d := time.Since(ended); d < -2*time.Second || d > 2*time.Second {
		t.Fatalf("ended cooldown_until = %v", got["cooldown_until"])
	}
	// A past cooldown is left alone.
	e.exec("UPDATE students SET cooldown_until = '2020-01-01 00:00:00' WHERE id = ?", s)
	if got := e.admin(http.MethodDelete, path, nil).status(http.StatusOK).object(); got["cooldown_until"] != "2020-01-01 00:00:00" {
		t.Fatalf("past cooldown changed to %v", got["cooldown_until"])
	}
	e.admin(http.MethodDelete, studentPath(999, "cooldown"), nil).wantError(http.StatusNotFound, "Student not found")
}

func TestImportStudents(t *testing.T) {
	e := newTestEnv(t)
	def := e.group("Default")
	e.exec("UPDATE groups SET is_default = 1 WHERE id = ?", def)
	other := e.group("Other")
	existing := e.student("Old", other)
	addr := e.studentEmail(existing)

	csv := strings.Join([]string{
		`"First_Name",last_name,email,membership_id,attended_sessions,active,preferred_days`,
		`"Smith, Jr.",Ann,ann@example.test,M-1,5,1,1|2`,
		`New,Name,` + addr + `,M-2,x,0,`,
		`,Missing,missing@example.test`,
		`Bo,Ng,bo@example.test`,
	}, "\n")
	res := e.admin(http.MethodPost, "/api/students/import", map[string]any{"csv": csv}).status(http.StatusOK).object()
	if res["imported"] != 3.0 || res["skipped"] != 1.0 || fmt.Sprint(res["errors"]) != "[Row 4: missing required fields]" {
		t.Fatalf("import = %v", res)
	}

	ann := e.row("SELECT * FROM students WHERE email = 'ann@example.test'")
	if ann["first_name"] != "Smith, Jr." || ann["membership_id"] != "M-1" || ann["attended_sessions"] != int64(5) || ann["preferred_days"] != "1|2" {
		t.Errorf("ann = %v", ann)
	}
	if g := e.row("SELECT group_id FROM student_groups WHERE student_id = ?", ann["id"]); toInt64(g["group_id"]) != def {
		t.Errorf("new student group = %v, want default", g)
	}
	// The existing student is updated by email; invalid numbers are ignored and their group kept.
	old := e.row("SELECT * FROM students WHERE id = ?", existing)
	if old["first_name"] != "New" || old["membership_id"] != "M-2" || old["attended_sessions"] != int64(0) || old["active"] != int64(0) {
		t.Errorf("updated = %v", old)
	}
	if g := e.row("SELECT group_id FROM student_groups WHERE student_id = ?", existing); toInt64(g["group_id"]) != other {
		t.Errorf("existing student moved to group %v", g)
	}

	e.admin(http.MethodPost, "/api/students/import", map[string]any{"csv": "first_name,email\nA,a@example.test"}).
		wantError(http.StatusBadRequest, "CSV must contain first_name, last_name, and email columns")
}

func TestExportStudents(t *testing.T) {
	e := newTestEnv(t)
	s := e.student("Ann", e.group("Juniors"))
	e.exec(`UPDATE students SET last_name = 'Lee, "Jr"' WHERE id = ?`, s)
	gone := e.student("Gone", e.group("Other"))
	e.exec("UPDATE students SET deleted_at = datetime('now') WHERE id = ?", gone)

	body := string(e.admin(http.MethodGet, "/api/students/export", nil).status(http.StatusOK).Body)
	want := "first_name,last_name,email,membership_id,attended_sessions,no_show_count,preferred_days,active\n" +
		`Ann,"Lee, ""Jr""",` + e.studentEmail(s) + `,,0,0,0|1|2|3|4|5|6,1`
	if body != want {
		t.Fatalf("export =\n%s\nwant\n%s", body, want)
	}
}
