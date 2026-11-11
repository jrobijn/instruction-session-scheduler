package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func sessionPath(id int64, rest ...string) string {
	p := fmt.Sprintf("/api/sessions/%d", id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func (e *testEnv) sessionStatus(id int64) string {
	e.t.Helper()
	return e.row("SELECT status FROM training_sessions WHERE id = ?", id)["status"].(string)
}

func (e *testEnv) studentID(firstName string) int64 {
	e.t.Helper()
	return e.row("SELECT id FROM students WHERE first_name = ?", firstName)["id"].(int64)
}

func (e *testEnv) instructorOfSlot(slotID int64) int64 {
	e.t.Helper()
	return e.row("SELECT instructor_id FROM session_slots WHERE id = ?", slotID)["instructor_id"].(int64)
}

// --- create, list, get, update, delete --------------------------------------------------

func TestCreateSession(t *testing.T) {
	e := newTestEnv(t)
	e.admin(http.MethodPost, "/api/sessions", map[string]any{}).wantError(http.StatusBadRequest, "Date is required")

	// Without a timetable the active, saved default is used.
	tt, _ := e.timetable("18:00")
	e.exec("UPDATE timetables SET is_default = 1 WHERE id = ?", tt)
	got := e.admin(http.MethodPost, "/api/sessions", map[string]any{"date": sessionDate, "notes": "Bring water"}).status(http.StatusCreated).object()
	if got["status"] != "draft" || toInt64(got["timetable_id"]) != tt || got["notes"] != "Bring water" {
		t.Fatalf("created session = %v", got)
	}
	if dow := e.row("SELECT day_of_week FROM training_sessions WHERE id = ?", got["id"])["day_of_week"]; dow != int64(1) {
		t.Fatalf("day_of_week = %v, want 1", dow)
	}

	e.admin(http.MethodPost, "/api/sessions", map[string]any{"date": sessionDate}).
		wantError(http.StatusConflict, "A training session already exists for this date")

	explicit, _ := e.timetable("09:00")
	got = e.admin(http.MethodPost, "/api/sessions", map[string]any{"date": "2030-01-08", "timetable_id": explicit}).status(http.StatusCreated).object()
	if toInt64(got["timetable_id"]) != explicit {
		t.Fatalf("timetable_id = %v, want %d", got["timetable_id"], explicit)
	}

	// A draft default timetable is not used.
	e.exec("UPDATE timetables SET status = 'draft' WHERE id = ?", tt)
	got = e.admin(http.MethodPost, "/api/sessions", map[string]any{"date": "2030-01-09"}).status(http.StatusCreated).object()
	if got["timetable_id"] != nil {
		t.Fatalf("timetable_id = %v, want none", got["timetable_id"])
	}
}

func TestSessionDateValidation(t *testing.T) {
	e := newTestEnv(t)
	for _, date := range []string{"next monday", "2030-02-30", "07-01-2030"} {
		e.admin(http.MethodPost, "/api/sessions", map[string]any{"date": date}).wantError(http.StatusBadRequest, "Invalid date")
	}
	e.admin(http.MethodPost, "/api/sessions", map[string]any{"date": 20300107}).wantError(http.StatusBadRequest, "Invalid value for date")
	if n := len(e.rows("SELECT 1 FROM training_sessions")); n != 0 {
		t.Fatalf("%d sessions created from invalid dates", n)
	}

	id := e.session(sessionDate, 0)
	e.session("2030-01-08", 0)
	e.admin(http.MethodPut, sessionPath(id), map[string]any{"date": "soon"}).wantError(http.StatusBadRequest, "Invalid date")
	e.admin(http.MethodPut, sessionPath(id), map[string]any{"date": "2030-01-08"}).
		wantError(http.StatusConflict, "A training session already exists for this date")

	// Moving a session also updates its day of the week.
	got := e.admin(http.MethodPut, sessionPath(id), map[string]any{"date": "2030-01-12"}).status(http.StatusOK).object()
	if got["date"] != "2030-01-12" {
		t.Fatalf("moved session = %v", got)
	}
	if dow := e.row("SELECT day_of_week FROM training_sessions WHERE id = ?", id)["day_of_week"]; dow != int64(6) {
		t.Fatalf("day_of_week = %v, want 6", dow)
	}
}

func TestCreateSessionRejectsMalformedJSON(t *testing.T) {
	e := newTestEnv(t)
	e.admin(http.MethodPost, "/api/sessions", "{not json").wantError(http.StatusBadRequest, "Invalid JSON body")
}

func TestListSessions(t *testing.T) {
	f, _ := invitedPair(t) // 1 instructor x 2 timeslots, A and B invited
	f.invitationAction("A", "confirm", nil).status(http.StatusOK)
	f.session("2029-12-01", 0)

	list := f.admin(http.MethodGet, "/api/sessions", nil).status(http.StatusOK).array()
	if len(list) != 2 || list[0]["date"] != sessionDate {
		t.Fatalf("sessions = %v, want newest first", list)
	}
	for k, want := range map[string]any{
		"instructor_count": 1.0, "invitation_count": 2.0, "confirmed_count": 1.0, "total_slots": 2.0, "timetable_name": "Timetable",
	} {
		if list[0][k] != want {
			t.Errorf("%s = %v, want %v", k, list[0][k], want)
		}
	}
	if list[1]["total_slots"] != 0.0 || list[1]["timetable_name"] != nil {
		t.Errorf("session without timetable = %v", list[1])
	}
}

func TestGetSession(t *testing.T) {
	f, _ := invitedPair(t)
	f.buddies(f.studentID("A"), f.studentID("B"))
	f.exec("UPDATE invitations SET invited_at = '2030-01-01 12:30:00' WHERE student_id = ?", f.studentID("A"))
	f.exec("UPDATE invitations SET invited_at = '2030-01-01 10:00:00' WHERE student_id = ?", f.studentID("B"))
	pinClock(t, utc("2030-01-01 13:00:00"))

	got := f.admin(http.MethodGet, sessionPath(f.sessionID), nil).status(http.StatusOK).object()
	if n := len(got["instructors"].([]any)); n != 1 {
		t.Fatalf("instructors = %d", n)
	}
	if n := len(got["timeslots"].([]any)); n != 2 {
		t.Fatalf("timeslots = %d", n)
	}
	if got["invitation_expiry_minutes"] != 120.0 || got["timetable"] == nil || len(got["timetableGroups"].([]any)) != 1 {
		t.Fatalf("session = %v", got)
	}
	invs := got["invitations"].([]any)
	if len(invs) != 2 {
		t.Fatalf("invitations = %d", len(invs))
	}
	byName := map[string]map[string]any{}
	for _, i := range invs {
		inv := i.(map[string]any)
		byName[inv["student_name"].(string)] = inv
	}
	if byName["A Test"]["buddy_group_name"] != "A & B" {
		t.Errorf("buddy_group_name = %v", byName["A Test"]["buddy_group_name"])
	}
	// Like GET /api/invitations/{token}: no deadline once the invitation is effectively
	// expired, even if its timer has not fired yet.
	if byName["B Test"]["status"] != "expired" || byName["B Test"]["expires_at"] != nil {
		t.Errorf("B = status %v, expires_at %v; want effective status expired", byName["B Test"]["status"], byName["B Test"]["expires_at"])
	}
	if byName["A Test"]["status"] != "invited" || byName["A Test"]["expires_at"] != "2030-01-01T14:30:00.000Z" {
		t.Errorf("A = status %v, expires_at %v", byName["A Test"]["status"], byName["A Test"]["expires_at"])
	}

	f.admin(http.MethodGet, "/api/sessions/999", nil).wantError(http.StatusNotFound, "Training session not found")
}

func TestUpdateSession(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("A", g)

	got := f.admin(http.MethodPut, sessionPath(f.sessionID), map[string]any{"notes": "New notes"}).status(http.StatusOK).object()
	if got["notes"] != "New notes" || got["date"] != sessionDate || toInt64(got["timetable_id"]) != f.timetable {
		t.Fatalf("updated = %v", got)
	}

	// Changing the timetable of a scheduled session clears its schedule.
	f.generate().status(http.StatusOK)
	other, _ := f.testEnv.timetable("09:00")
	f.admin(http.MethodPut, sessionPath(f.sessionID), map[string]any{"timetable_id": other}).status(http.StatusOK)
	if n := len(f.invitationRows()); n != 0 || f.sessionStatus(f.sessionID) != "draft" {
		t.Fatalf("after timetable change: %d invitations, status %s", n, f.sessionStatus(f.sessionID))
	}

	// Null removes the timetable; leaving the key out keeps the current one.
	got = f.admin(http.MethodPut, sessionPath(f.sessionID), map[string]any{"timetable_id": nil}).status(http.StatusOK).object()
	if got["timetable_id"] != nil {
		t.Fatalf("timetable_id = %v after null, want none", got["timetable_id"])
	}
	f.admin(http.MethodPut, sessionPath(f.sessionID), map[string]any{"timetable_id": other}).status(http.StatusOK)
	got = f.admin(http.MethodPut, sessionPath(f.sessionID), map[string]any{"notes": "Kept"}).status(http.StatusOK).object()
	if toInt64(got["timetable_id"]) != other {
		t.Fatalf("timetable_id = %v without the key, want %d", got["timetable_id"], other)
	}

	// Same timetable again is not a change.
	f.exec("UPDATE training_sessions SET status = 'invitations_sent'")
	f.admin(http.MethodPut, sessionPath(f.sessionID), map[string]any{"timetable_id": other}).status(http.StatusOK)
	f.admin(http.MethodPut, sessionPath(f.sessionID), map[string]any{"timetable_id": f.timetable}).
		wantError(http.StatusBadRequest, "Cannot change timetable after invitations have been sent")
	f.admin(http.MethodPut, sessionPath(f.sessionID), map[string]any{"timetable_id": nil}).
		wantError(http.StatusBadRequest, "Cannot change timetable after invitations have been sent")

	f.admin(http.MethodPut, "/api/sessions/999", map[string]any{}).wantError(http.StatusNotFound, "Training session not found")
}

func TestDeleteSession(t *testing.T) {
	f, _ := invitedPair(t)
	f.admin(http.MethodDelete, sessionPath(f.sessionID), nil).status(http.StatusOK)
	if n := len(f.rows("SELECT 1 FROM invitations")); n != 0 {
		t.Fatalf("%d invitations survive the session", n)
	}
	f.admin(http.MethodDelete, sessionPath(f.sessionID), nil).wantError(http.StatusNotFound, "Training session not found")
}

// --- instructors ------------------------------------------------------------------------

func TestAssignInstructor(t *testing.T) {
	e := newTestEnv(t)
	tt, _ := e.timetable("18:00")
	sid := e.session(sessionDate, tt)
	in := e.instructor("Smith")
	path := sessionPath(sid, "instructors")

	e.admin(http.MethodPost, path, map[string]any{}).wantError(http.StatusBadRequest, "instructor_id is required")
	e.admin(http.MethodPost, path, map[string]any{"instructor_id": in}).status(http.StatusCreated)
	e.admin(http.MethodPost, path, map[string]any{"instructor_id": in}).wantError(http.StatusConflict, "Instructor already assigned to this session")
	e.admin(http.MethodPost, path, map[string]any{"instructor_id": 999}).wantError(http.StatusBadRequest, "Invalid instructor")
	e.admin(http.MethodPost, "/api/sessions/999/instructors", map[string]any{"instructor_id": in}).wantError(http.StatusNotFound, "Training session not found")

	// Re-assigning a removed instructor revives the same slot.
	slot := e.row("SELECT id FROM session_slots WHERE session_id = ?", sid)["id"]
	e.admin(http.MethodDelete, sessionPath(sid, "instructors", fmt.Sprint(in)), nil).status(http.StatusOK)
	e.admin(http.MethodPost, path, map[string]any{"instructor_id": in}).status(http.StatusCreated)
	rows := e.rows("SELECT id, removed FROM session_slots WHERE session_id = ?", sid)
	if len(rows) != 1 || rows[0]["id"] != slot || rows[0]["removed"] != int64(0) {
		t.Fatalf("slots after re-assign = %v", rows)
	}
}

func TestRemoveInstructor(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 2)
	g := f.groupIn("Juniors", 100)
	for _, n := range []string{"A", "B", "C", "D"} {
		f.student(n, g)
	}
	f.sendInvitations()
	slot := f.slots[0]
	instructor := f.instructorOfSlot(slot)
	onSlot := f.rows("SELECT s.first_name FROM invitations inv JOIN students s ON s.id = inv.student_id WHERE inv.slot_id = ? ORDER BY s.first_name", slot)
	if len(onSlot) != 2 {
		t.Fatalf("%d invitations on the slot, want 2", len(onSlot))
	}
	confirmed, invited := onSlot[0]["first_name"].(string), onSlot[1]["first_name"].(string)
	f.invitationAction(confirmed, "confirm", nil).status(http.StatusOK)
	// A scheduled (unsent) invitation on the same slot is deleted outright.
	f.invitation(f.sessionID, f.student("E", g), f.timeslots[0], slot, g, "declined")
	mailBefore := len(f.sentMail())

	res := f.admin(http.MethodDelete, sessionPath(f.sessionID, "instructors", fmt.Sprint(instructor)), nil).status(http.StatusOK).object()
	if res["cancelled"] != 2.0 {
		t.Fatalf("cancelled = %v, want 2", res["cancelled"])
	}
	for _, n := range []string{confirmed, invited} {
		if st := f.statusOf(n); st != "admin_cancelled" {
			t.Errorf("%s status = %s, want admin_cancelled", n, st)
		}
	}
	if st := f.statusOf("E"); st != "declined" {
		t.Errorf("history invitation status = %s, want it kept as declined", st)
	}
	if n := len(f.sentMail()) - mailBefore; n != 2 {
		t.Errorf("sent %d cancellation emails, want 2", n)
	}
	if f.timerCount() != 2 {
		t.Errorf("%d timers, want 2 (only the other instructor's invitations)", f.timerCount())
	}
	if r := f.row("SELECT removed FROM session_slots WHERE id = ?", slot); r["removed"] != int64(1) {
		t.Fatal("slot not marked removed")
	}

	f.admin(http.MethodDelete, sessionPath(f.sessionID, "instructors", fmt.Sprint(instructor)), nil).wantError(http.StatusNotFound, "Assignment not found")
	f.exec("UPDATE training_sessions SET status = 'completed'")
	f.admin(http.MethodDelete, sessionPath(f.sessionID, "instructors", fmt.Sprint(f.instructorOfSlot(f.slots[1]))), nil).
		wantError(http.StatusBadRequest, "Cannot modify a completed session")
}

func TestRemoveInstructorDeletesScheduledInvitations(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("A", g)
	f.generate().status(http.StatusOK)

	f.admin(http.MethodDelete, sessionPath(f.sessionID, "instructors", fmt.Sprint(f.instructorOfSlot(f.slots[0]))), nil).status(http.StatusOK)
	if n := len(f.invitationRows()); n != 0 {
		t.Fatalf("%d invitations left", n)
	}
	if len(f.sentMail()) != 0 {
		t.Fatal("unsent invitations should not trigger emails")
	}
}

func TestReplaceInstructor(t *testing.T) {
	f, _ := invitedPair(t)
	slot := f.slots[0]
	old := f.instructorOfSlot(slot)
	replacement := f.instructor("Replacement")
	path := sessionPath(f.sessionID, "instructors", fmt.Sprint(old), "replace")

	f.admin(http.MethodPost, path, map[string]any{}).wantError(http.StatusBadRequest, "new_instructor_id is required")
	f.admin(http.MethodPost, path, map[string]any{"new_instructor_id": old}).wantError(http.StatusBadRequest, "New instructor must be different")
	f.admin(http.MethodPost, path, map[string]any{"new_instructor_id": 999}).wantError(http.StatusBadRequest, "New instructor not found")
	f.admin(http.MethodPost, sessionPath(f.sessionID, "instructors", "999", "replace"), map[string]any{"new_instructor_id": replacement}).
		wantError(http.StatusNotFound, "Original instructor not assigned to this session")

	f.admin(http.MethodPost, path, map[string]any{"new_instructor_id": replacement}).status(http.StatusOK)
	if got := f.instructorOfSlot(slot); got != replacement {
		t.Fatalf("slot instructor = %d, want %d", got, replacement)
	}
	// Invitations stay on the slot and so move to the new instructor.
	if toInt64(f.invitationOf("A")["slot_id"]) != slot || f.statusOf("A") != "invited" {
		t.Fatal("invitations were not kept on the slot")
	}

	other := f.instructor("Other")
	f.assign(f.sessionID, other)
	f.admin(http.MethodPost, sessionPath(f.sessionID, "instructors", fmt.Sprint(replacement), "replace"), map[string]any{"new_instructor_id": other}).
		wantError(http.StatusConflict, "New instructor is already assigned to this session")
}

func TestReplaceInstructorMergesRemovedSlot(t *testing.T) {
	f, g := invitedPair(t)
	slot := f.slots[0]
	old := f.instructorOfSlot(slot)
	// The new instructor used to be assigned and has history on their removed slot.
	returning := f.instructor("Returning")
	removedSlot := f.assign(f.sessionID, returning)
	f.exec("UPDATE session_slots SET removed = 1 WHERE id = ?", removedSlot)
	history := f.invitation(f.sessionID, f.student("E", g), f.timeslots[0], removedSlot, g, "admin_cancelled")

	f.admin(http.MethodPost, sessionPath(f.sessionID, "instructors", fmt.Sprint(old), "replace"), map[string]any{"new_instructor_id": returning}).status(http.StatusOK)
	if f.row("SELECT 1 FROM session_slots WHERE id = ?", removedSlot) != nil {
		t.Fatal("removed slot should be merged away")
	}
	if got := toInt64(f.row("SELECT slot_id FROM invitations WHERE id = ?", history)["slot_id"]); got != slot {
		t.Fatalf("history invitation on slot %d, want %d", got, slot)
	}
	if f.instructorOfSlot(slot) != returning {
		t.Fatal("slot not re-pointed")
	}
}

// --- sending, adding and removing invitations -------------------------------------------

func TestAddInvitationManually(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	a, b := f.student("A", g), f.student("B", g)
	instructor := f.instructorOfSlot(f.slots[0])
	path := sessionPath(f.sessionID, "invitations")
	body := func(student, timeslot int64) map[string]any {
		return map[string]any{"student_id": student, "timeslot_id": timeslot, "instructor_id": instructor}
	}

	f.admin(http.MethodPost, path, map[string]any{"student_id": a}).
		wantError(http.StatusBadRequest, "student_id, timeslot_id, and instructor_id are required")
	f.admin(http.MethodPost, path, map[string]any{"student_id": a, "timeslot_id": f.timeslots[0], "instructor_id": 999}).
		wantError(http.StatusBadRequest, "Instructor is not assigned to this session")

	f.admin(http.MethodPost, path, body(a, f.timeslots[0])).status(http.StatusCreated)
	if f.sessionStatus(f.sessionID) != "scheduled" {
		t.Fatal("adding to a draft session should make it scheduled")
	}
	inv := f.invitationOf("A")
	if inv["status"] != "scheduled" || inv["group_id"] != nil || len(f.sentMail()) != 0 {
		t.Fatalf("manual invitation before sending: %v", inv)
	}
	f.admin(http.MethodPost, path, body(a, f.timeslots[1])).wantError(http.StatusConflict, "Student already has an active invitation for this session")
	f.admin(http.MethodPost, path, body(b, f.timeslots[0])).wantError(http.StatusConflict, "This slot is already occupied")

	// After invitations went out, a manually added student is invited immediately.
	f.admin(http.MethodPost, sessionPath(f.sessionID, "send-invitations"), nil).status(http.StatusOK)
	f.admin(http.MethodPost, path, body(b, f.timeslots[1])).status(http.StatusCreated)
	invB := f.invitationOf("B")
	if invB["status"] != "invited" || len(f.mailTo(f.studentEmail(b))) != 1 || !f.hasTimer(toInt64(invB["id"])) {
		t.Fatalf("manual invitation after sending: %v", invB)
	}

	f.exec("UPDATE training_sessions SET status = 'completed'")
	f.admin(http.MethodPost, path, body(b, f.timeslots[1])).wantError(http.StatusBadRequest, "Can only add students before session is completed")
}

func TestAddInvitationReusesVacatedSlot(t *testing.T) {
	f, g := invitedPair(t)
	f.exec("UPDATE invitations SET status = 'declined' WHERE student_id = ?", f.studentID("A"))
	e := f.student("E", g)
	f.admin(http.MethodPost, sessionPath(f.sessionID, "invitations"), map[string]any{
		"student_id": e, "timeslot_id": f.timeslots[0], "instructor_id": f.instructorOfSlot(f.slots[0]),
	}).status(http.StatusCreated)
	// A's declined invitation no longer blocks A, but the spot is now taken by E.
	f.admin(http.MethodPost, sessionPath(f.sessionID, "invitations"), map[string]any{
		"student_id": f.studentID("A"), "timeslot_id": f.timeslots[0], "instructor_id": f.instructorOfSlot(f.slots[0]),
	}).wantError(http.StatusConflict, "This slot is already occupied")
}

func TestDeleteInvitation(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("A", g)
	f.student("B", g)
	f.generate().status(http.StatusOK)
	a, b := toInt64(f.invitationOf("A")["id"]), toInt64(f.invitationOf("B")["id"])

	f.admin(http.MethodDelete, sessionPath(f.sessionID, "invitations", fmt.Sprint(a)), nil).status(http.StatusOK)
	if f.sessionStatus(f.sessionID) != "scheduled" {
		t.Fatal("session should stay scheduled while invitations remain")
	}
	f.admin(http.MethodDelete, sessionPath(f.sessionID, "invitations", fmt.Sprint(a)), nil).wantError(http.StatusNotFound, "Invitation not found")
	f.admin(http.MethodDelete, sessionPath(f.sessionID, "invitations", fmt.Sprint(b)), nil).status(http.StatusOK)
	if f.sessionStatus(f.sessionID) != "draft" {
		t.Fatal("session should revert to draft without invitations")
	}

	f.exec("UPDATE training_sessions SET status = 'invitations_sent'")
	f.admin(http.MethodDelete, sessionPath(f.sessionID, "invitations", "1"), nil).
		wantError(http.StatusBadRequest, "Can only remove students before invitations are sent")
}

func TestAvailableStudents(t *testing.T) {
	f, g := invitedPair(t) // A, B invited; C, D waiting
	f.exec("UPDATE invitations SET status = 'declined' WHERE student_id = ?", f.studentID("B"))
	inactive := f.student("Inactive", g)
	f.exec("UPDATE students SET active = 0 WHERE id = ?", inactive)
	path := sessionPath(f.sessionID, "available-students") + "?q="

	if got := f.admin(http.MethodGet, path+"T", nil).status(http.StatusOK).array(); len(got) != 0 {
		t.Fatalf("one-character query returned %v", got)
	}
	var names []string
	for _, s := range f.admin(http.MethodGet, path+"Test", nil).status(http.StatusOK).array() {
		names = append(names, s["first_name"].(string))
	}
	if strings.Join(names, ",") != "B,C,D" {
		t.Fatalf("available = %v, want B (declined), C and D", names)
	}
	if got := f.admin(http.MethodGet, path+"c.3%40example", nil).status(http.StatusOK).array(); len(got) != 1 || got[0]["first_name"] != "C" {
		t.Fatalf("search by email = %v", got)
	}
}

func TestAdminCancelInvitation(t *testing.T) {
	f, _ := invitedPair(t)
	inv := f.invitationOf("A")
	path := sessionPath(f.sessionID, "invitations", fmt.Sprint(inv["id"]), "admin-cancel")
	mailBefore := len(f.mailTo(f.studentEmail(f.studentID("A"))))

	f.admin(http.MethodPost, path, nil).status(http.StatusOK)
	if f.statusOf("A") != "admin_cancelled" || f.hasTimer(toInt64(inv["id"])) {
		t.Fatal("invitation not admin-cancelled")
	}
	if n := len(f.mailTo(f.studentEmail(f.studentID("A")))) - mailBefore; n != 1 {
		t.Fatalf("sent %d cancellation emails, want 1", n)
	}
	// Admin cancel does not invite a replacement.
	if n := len(f.invitationRows()); n != 2 {
		t.Fatalf("%d invitations, want 2", n)
	}
	f.admin(http.MethodPost, path, nil).wantError(http.StatusBadRequest, "Cannot cancel — invitation is already admin_cancelled")
	f.admin(http.MethodPost, sessionPath(f.sessionID, "invitations", "999", "admin-cancel"), nil).wantError(http.StatusNotFound, "Invitation not found")
}

func TestAdminCancelUnsentInvitationSendsNoEmail(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	f.student("A", f.groupIn("Juniors", 100))
	f.generate().status(http.StatusOK)
	f.admin(http.MethodPost, sessionPath(f.sessionID, "invitations", fmt.Sprint(f.invitationOf("A")["id"]), "admin-cancel"), nil).status(http.StatusOK)
	if len(f.sentMail()) != 0 {
		t.Fatal("cancelling an unsent invitation emailed the student")
	}
}

func TestAutoScheduleSlot(t *testing.T) {
	f, g := invitedPair(t)
	a := f.invitationOf("A")
	path := sessionPath(f.sessionID, "auto-schedule-slot")
	body := map[string]any{"timeslot_id": a["timeslot_id"], "instructor_id": f.instructorOfSlot(f.slots[0])}

	f.admin(http.MethodPost, path, body).wantError(http.StatusConflict, "This slot is already occupied")
	f.admin(http.MethodPost, path, map[string]any{}).wantError(http.StatusBadRequest, "timeslot_id and instructor_id are required")
	f.admin(http.MethodPost, path, map[string]any{"timeslot_id": a["timeslot_id"], "instructor_id": 999}).
		wantError(http.StatusBadRequest, "Instructor is not assigned to this session")

	f.admin(http.MethodPost, sessionPath(f.sessionID, "invitations", fmt.Sprint(a["id"]), "admin-cancel"), nil).status(http.StatusOK)
	res := f.admin(http.MethodPost, path, body).status(http.StatusOK).object()
	if repl, _ := res["replacement"].(map[string]any); repl == nil || repl["name"] != "C Test" {
		t.Fatalf("replacement = %v, want C", res["replacement"])
	}
	c := f.invitationOf("C")
	if c["status"] != "invited" || toInt64(c["group_id"]) != g || c["timeslot_id"] != a["timeslot_id"] {
		t.Fatalf("auto-scheduled invitation = %v", c)
	}

	f.exec("UPDATE training_sessions SET status = 'scheduled'")
	f.admin(http.MethodPost, path, body).wantError(http.StatusBadRequest, "Auto-scheduling is only available after invitations are sent")
}

// --- no-shows and completion ------------------------------------------------------------

func TestToggleNoShowAndComplete(t *testing.T) {
	f, _ := invitedPair(t)
	f.invitationAction("A", "confirm", nil).status(http.StatusOK)
	f.invitationAction("B", "confirm", nil).status(http.StatusOK)
	toggle := func(name string) *response {
		return f.admin(http.MethodPost, sessionPath(f.sessionID, "invitations", fmt.Sprint(f.invitationOf(name)["id"]), "toggle-no-show"), nil)
	}

	if got := toggle("B").status(http.StatusOK).object(); got["no_show"] != 1.0 {
		t.Fatalf("toggle = %v", got)
	}
	toggle("A").status(http.StatusOK)
	if got := toggle("A").status(http.StatusOK).object(); got["no_show"] != 0.0 {
		t.Fatalf("toggle back = %v", got)
	}

	res := f.admin(http.MethodPost, sessionPath(f.sessionID, "complete"), nil).status(http.StatusOK).object()
	if res["students_credited"] != 2.0 {
		t.Fatalf("complete = %v", res)
	}
	a := f.row("SELECT attended_sessions, no_show_count FROM students WHERE first_name = 'A'")
	b := f.row("SELECT attended_sessions, no_show_count FROM students WHERE first_name = 'B'")
	if a["attended_sessions"] != int64(1) || a["no_show_count"] != int64(0) || b["attended_sessions"] != int64(0) || b["no_show_count"] != int64(1) {
		t.Fatalf("A = %v, B = %v", a, b)
	}

	f.admin(http.MethodPost, sessionPath(f.sessionID, "complete"), nil).wantError(http.StatusBadRequest, "Session already completed")
	toggle("A").wantError(http.StatusBadRequest, "Session already completed")
}

func TestToggleNoShowRequiresConfirmed(t *testing.T) {
	f, _ := invitedPair(t)
	f.admin(http.MethodPost, sessionPath(f.sessionID, "invitations", fmt.Sprint(f.invitationOf("A")["id"]), "toggle-no-show"), nil).
		wantError(http.StatusBadRequest, "Only confirmed invitations can be toggled")
	f.admin(http.MethodPost, sessionPath(f.sessionID, "invitations", "999", "toggle-no-show"), nil).
		wantError(http.StatusNotFound, "Invitation not found")
}

// --- cancelling and reactivating sessions -----------------------------------------------

func TestCancelAndReactivateSession(t *testing.T) {
	f, g := invitedPair(t)
	f.invitationAction("A", "confirm", nil).status(http.StatusOK)
	// An unsent scheduled invitation is cancelled without an email.
	unsent := f.student("E", g)
	f.invitation(f.sessionID, unsent, f.timeslots[0], f.slots[0], 0, "scheduled")
	mailBefore := len(f.sentMail())

	f.admin(http.MethodPost, sessionPath(f.sessionID, "reactivate"), nil).wantError(http.StatusBadRequest, "Only cancelled sessions can be reactivated")

	res := f.admin(http.MethodPost, sessionPath(f.sessionID, "cancel"), nil).status(http.StatusOK).object()
	if res["cancelled_invitations"] != 2.0 {
		t.Fatalf("cancel = %v", res)
	}
	for _, n := range []string{"A", "B", "E"} {
		if st := f.statusOf(n); st != "admin_cancelled" {
			t.Errorf("%s status = %s", n, st)
		}
	}
	if n := len(f.sentMail()) - mailBefore; n != 2 {
		t.Errorf("sent %d emails, want 2 (A and B, not E)", n)
	}
	if f.sessionStatus(f.sessionID) != "cancelled" {
		t.Fatal("session not cancelled")
	}
	f.admin(http.MethodPost, sessionPath(f.sessionID, "cancel"), nil).wantError(http.StatusBadRequest, "Session is already cancelled")

	res = f.admin(http.MethodPost, sessionPath(f.sessionID, "reactivate"), nil).status(http.StatusOK).object()
	if res["new_status"] != "draft" || f.sessionStatus(f.sessionID) != "draft" || len(f.invitationRows()) != 0 {
		t.Fatalf("reactivate = %v; invitations left: %d", res, len(f.invitationRows()))
	}

	f.exec("UPDATE training_sessions SET status = 'completed'")
	f.admin(http.MethodPost, sessionPath(f.sessionID, "cancel"), nil).wantError(http.StatusBadRequest, "Cannot cancel a completed session")
}
