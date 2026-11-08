package server

import (
	"fmt"
	"maps"
	"net/http"
	"slices"
	"testing"
)

func TestInstructorCRUD(t *testing.T) {
	e := newTestEnv(t)
	e.admin(http.MethodPost, "/api/instructors", map[string]any{"first_name": "A"}).
		wantError(http.StatusBadRequest, "First name, last name and email are required")
	id := toInt64(e.admin(http.MethodPost, "/api/instructors", map[string]any{"first_name": "Ida", "last_name": "Zed", "email": "ida@example.test"}).
		status(http.StatusCreated).object()["id"])
	e.admin(http.MethodPost, "/api/instructors", map[string]any{"first_name": "X", "last_name": "Y", "email": "ida@example.test"}).
		wantError(http.StatusConflict, "An instructor with this email already exists")
	other := e.instructor("Able")

	got := e.admin(http.MethodPut, fmt.Sprintf("/api/instructors/%d", id), map[string]any{"first_name": "Ada"}).status(http.StatusOK).object()
	if got["first_name"] != "Ada" || got["last_name"] != "Zed" {
		t.Fatalf("updated = %v", got)
	}
	e.admin(http.MethodPut, fmt.Sprintf("/api/instructors/%d", id), map[string]any{"email": fmt.Sprintf("instructor%d@example.test", 1)}).
		wantError(http.StatusConflict, "An instructor with this email already exists")

	list := e.admin(http.MethodGet, "/api/instructors", nil).status(http.StatusOK).array()
	if len(list) != 2 || toInt64(list[0]["id"]) != other {
		t.Fatalf("instructors = %v, want sorted by last name", list)
	}

	// Only the API fields are exposed, not every column (created_at, deleted_at).
	one := e.admin(http.MethodGet, fmt.Sprintf("/api/instructors/%d", id), nil).status(http.StatusOK).object()
	if keys := slices.Sorted(maps.Keys(one)); !slices.Equal(keys, []string{"active", "email", "first_name", "id", "last_name"}) {
		t.Fatalf("instructor fields = %v", keys)
	}
	if one["active"] != float64(1) || one["email"] != "ida@example.test" {
		t.Fatalf("instructor = %v", one)
	}

	e.admin(http.MethodDelete, fmt.Sprintf("/api/instructors/%d", id), nil).status(http.StatusOK)
	e.admin(http.MethodGet, fmt.Sprintf("/api/instructors/%d", id), nil).wantError(http.StatusNotFound, "Instructor not found")
	e.admin(http.MethodPut, fmt.Sprintf("/api/instructors/%d", id), map[string]any{}).wantError(http.StatusNotFound, "Instructor not found")
	e.admin(http.MethodDelete, fmt.Sprintf("/api/instructors/%d", id), nil).wantError(http.StatusNotFound, "Instructor not found")
	if n := len(e.admin(http.MethodGet, "/api/instructors", nil).status(http.StatusOK).array()); n != 1 {
		t.Fatalf("%d instructors listed after delete", n)
	}
}

func TestDeleteInstructorRemovesThemFromSessions(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 2)
	g := f.groupIn("Juniors", 100)
	for _, n := range []string{"A", "B", "C", "D"} {
		f.student(n, g)
	}
	f.sendInvitations() // each instructor has two invited students
	gone, stays := f.instructorOfSlot(f.slots[0]), f.instructorOfSlot(f.slots[1])
	onSlot := func(slot int64) []map[string]any {
		return f.rows("SELECT inv.*, s.email FROM invitations inv JOIN students s ON s.id = inv.student_id WHERE inv.slot_id = ?", slot)
	}
	goneInvs := onSlot(f.slots[0])
	f.invitationAction(f.row("SELECT first_name FROM students WHERE id = ?", goneInvs[0]["student_id"])["first_name"].(string), "confirm", nil).
		status(http.StatusOK)

	// A later draft session with an unsent invitation, and a completed past session.
	draft := f.session("2030-02-04", f.timetable)
	draftSlot := f.assign(draft, gone)
	f.assign(draft, stays)
	f.invitation(draft, f.studentID("A"), f.timeslots[0], draftSlot, g, "scheduled")
	past := f.session("2029-06-01", f.timetable)
	pastSlot := f.assign(past, gone)
	pastInv := f.invitation(past, f.studentID("B"), f.timeslots[0], pastSlot, g, "confirmed")
	f.exec("UPDATE training_sessions SET status = 'completed' WHERE id = ?", past)
	mailBefore := len(f.sentMail())

	f.admin(http.MethodDelete, fmt.Sprintf("/api/instructors/%d", gone), nil).status(http.StatusOK)

	removed := func(slot int64) bool {
		return f.row("SELECT removed FROM session_slots WHERE id = ?", slot)["removed"] == int64(1)
	}
	if !removed(f.slots[0]) || !removed(draftSlot) || removed(f.slots[1]) || removed(pastSlot) {
		t.Fatalf("removed: session %v, draft %v, other instructor %v, completed %v",
			removed(f.slots[0]), removed(draftSlot), removed(f.slots[1]), removed(pastSlot))
	}
	// Their invited and confirmed students are admin-cancelled and emailed...
	for _, inv := range onSlot(f.slots[0]) {
		if inv["status"] != "admin_cancelled" || f.hasTimer(toInt64(inv["id"])) {
			t.Errorf("invitation %v = %s", inv["id"], inv["status"])
		}
	}
	if n := len(f.sentMail()) - mailBefore; n != 2 {
		t.Errorf("sent %d cancellation emails, want 2", n)
	}
	// ...the unsent one is deleted, the other instructor's are untouched, history is kept.
	if n := len(onSlot(draftSlot)); n != 0 {
		t.Errorf("%d invitations left on the draft session slot", n)
	}
	for _, inv := range onSlot(f.slots[1]) {
		if inv["status"] != "invited" {
			t.Errorf("other instructor's invitation = %s", inv["status"])
		}
	}
	if f.row("SELECT status FROM invitations WHERE id = ?", pastInv)["status"] != "confirmed" {
		t.Error("completed session history was changed")
	}

	// Scheduling the draft session only uses the remaining instructor.
	f.sessionID = draft
	f.generate().status(http.StatusOK)
	for _, inv := range f.invitationRows() {
		if toInt64(inv["slot_id"]) == draftSlot {
			t.Fatal("deleted instructor still gets students scheduled")
		}
	}
}

func TestInstructorImportExport(t *testing.T) {
	e := newTestEnv(t)
	e.exec("INSERT INTO instructors (first_name, last_name, email) VALUES ('Old', 'Name', 'old@example.test')")
	csv := "first_name,last_name,email\nNew,Name,old@example.test\nBo,Ng,bo@example.test\nNo,Email,"
	res := e.admin(http.MethodPost, "/api/instructors/import", map[string]any{"csv": csv}).status(http.StatusOK).object()
	if res["imported"] != 2.0 || res["skipped"] != 1.0 {
		t.Fatalf("import = %v", res)
	}
	body := string(e.admin(http.MethodGet, "/api/instructors/export", nil).status(http.StatusOK).Body)
	if want := "first_name,last_name,email,active\nNew,Name,old@example.test,1\nBo,Ng,bo@example.test,1"; body != want {
		t.Fatalf("export = %q", body)
	}
	e.admin(http.MethodPost, "/api/instructors/import", map[string]any{"csv": "name\nx"}).
		wantError(http.StatusBadRequest, "CSV must contain first_name, last_name, and email columns")
}

// A soft-deleted instructor's email stays taken; importing it again is a row error.
func TestImportInstructorWithDeletedEmail(t *testing.T) {
	e := newTestEnv(t)
	id := e.instructor("Gone")
	addr := e.row("SELECT email FROM instructors WHERE id = ?", id)["email"].(string)
	e.admin(http.MethodDelete, fmt.Sprintf("/api/instructors/%d", id), nil).status(http.StatusOK)

	res := e.admin(http.MethodPost, "/api/instructors/import", map[string]any{"csv": "first_name,last_name,email\nIda,Back," + addr + "\nNew,One,new@example.test"}).
		status(http.StatusOK).object()
	if res["imported"] != 1.0 || res["skipped"] != 1.0 || fmt.Sprint(res["errors"]) != "[Row 2: An instructor with this email already exists]" {
		t.Fatalf("import = %v", res)
	}
}
