package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

// Which student replaces a vacated spot. The fixtures (invitedPair, invitationOf) are in
// invitations_test.go; declining itself is tested there, expiry in timers_test.go.

// A declines; next in line is C, but D's buddy B is invited, so D is pulled up.
func TestReplacementPullsUpBuddyOfInvitedStudent(t *testing.T) {
	f, _ := invitedPair(t)
	b := f.row("SELECT id FROM students WHERE first_name = 'B'")["id"].(int64)
	d := f.row("SELECT id FROM students WHERE first_name = 'D'")["id"].(int64)
	f.buddies(b, d)

	res := f.invitationAction("A", "decline", nil).status(http.StatusOK).object()
	if repl := res["replacement"].(map[string]any); repl["name"] != "D Test" {
		t.Fatalf("replacement = %v, want D (pulled up by buddy B)", repl)
	}
	var log map[string]any
	json.Unmarshal([]byte(f.invitationOf("D")["decision_log"].(string)), &log)
	if log["buddy_placed_near"] != "B Test" || log["candidate_rank"] != float64(2) || log["candidates_considered"] != float64(2) {
		t.Fatalf("decision_log = %v, want buddy B, rank 2 of 2", log)
	}
}

// A buddy who declined is not coming, so they don't pull anyone up.
func TestReplacementIgnoresBuddyWhoDeclined(t *testing.T) {
	f, _ := invitedPair(t)
	a := f.row("SELECT id FROM students WHERE first_name = 'A'")["id"].(int64)
	d := f.row("SELECT id FROM students WHERE first_name = 'D'")["id"].(int64)
	f.buddies(a, d)

	res := f.invitationAction("A", "decline", nil).status(http.StatusOK).object()
	if repl := res["replacement"].(map[string]any); repl["name"] != "C Test" {
		t.Fatalf("replacement = %v, want C (A declined, so D isn't pulled up)", repl)
	}
}

func TestVacatedSpotRandomIsSeeded(t *testing.T) {
	spot := vacatedSpot{TimeslotID: 3, SlotID: 4, InvitationID: 5}
	other := spot
	other.InvitationID = 6
	if spot.random()() != spot.random()() {
		t.Error("the same vacated invitation gives different draws")
	}
	if spot.random()() == other.random()() {
		t.Error("different vacated invitations give the same draw")
	}
}

func TestReplacementSkipsStudentsPreferringOtherTimeslots(t *testing.T) {
	f, _ := invitedPair(t)
	c := f.row("SELECT id FROM students WHERE first_name = 'C'")["id"].(int64)
	f.preferTimeslots(c, f.timetable, f.timeslots[1]) // A's spot is 18:00

	res := f.invitationAction("A", "decline", nil).status(http.StatusOK).object()
	if repl := res["replacement"].(map[string]any); repl["name"] != "D Test" {
		t.Fatalf("replacement = %v, want D", repl)
	}
}

func TestReplacementFallsBackToOtherGroup(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	a := f.groupIn("A", 100)
	b := f.groupIn("B", 0)
	f.student("A1", a)
	f.student("B1", b)
	f.sendInvitations()

	res := f.invitationAction("A1", "decline", nil).status(http.StatusOK).object()
	if repl, _ := res["replacement"].(map[string]any); repl == nil || repl["name"] != "B1 Test" {
		t.Fatalf("replacement = %v, want B1", res["replacement"])
	}
	var log map[string]any
	json.Unmarshal([]byte(f.invitationOf("B1")["decision_log"].(string)), &log)
	if log["same_group_match"] != false || log["group_name"] != "B" {
		t.Fatalf("decision_log = %v", log)
	}
	if toInt64(f.invitationOf("B1")["group_id"]) != b {
		t.Fatal("replacement should be recorded in its own group")
	}
}

func TestReplacementSkipsGroupsOutsideTimetable(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	a := f.groupIn("A", 100)
	f.student("A1", a)
	f.student("Outsider", f.group("NotInTimetable"))
	f.sendInvitations()

	res := f.invitationAction("A1", "decline", nil).status(http.StatusOK).object()
	if res["replacement"] != nil {
		t.Fatalf("replacement = %v, want none", res["replacement"])
	}
}

// candidate_rank and candidates_considered count within the replacement's group, and only
// students who could take the spot: not other groups, nor groups outside the timetable.
func TestReplacementLogCountsWithinGroup(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	a := f.groupIn("A", 100)
	f.student("A1", a)
	f.student("A2", a)
	f.student("B1", f.groupIn("B", 0))
	f.student("Outsider", f.group("NotInTimetable"))
	f.sendInvitations()
	invited := f.row("SELECT s.first_name FROM invitations i JOIN students s ON s.id = i.student_id")["first_name"].(string)
	other := map[string]string{"A1": "A2", "A2": "A1"}[invited]

	f.invitationAction(invited, "decline", nil).status(http.StatusOK)
	var log map[string]any
	json.Unmarshal([]byte(f.invitationOf(other)["decision_log"].(string)), &log)
	if log["candidate_rank"] != float64(1) || log["candidates_considered"] != float64(1) {
		t.Fatalf("decision_log = %v, want rank 1 of 1", log)
	}
}
