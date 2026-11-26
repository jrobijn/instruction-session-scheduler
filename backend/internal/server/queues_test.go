package server

import (
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"
)

func (f *scheduleFixture) queues(day string) *response {
	f.t.Helper()
	return f.admin(http.MethodGet, fmt.Sprintf("/api/timetables/%d/queues?day=%s", f.timetable, day), nil)
}

func TestTimetableQueues(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	f.pinClock(time.Date(2030, 1, 3, 12, 0, 0, 0, time.UTC))
	g := f.groupIn("Juniors", 100)
	first := f.student("First", g)
	f.student("Second", g)
	last := f.student("Last", g)
	f.exec("UPDATE student_groups SET invite_next_at = '2029-12-01 00:00:00' WHERE student_id = ?", last)
	f.preferTimeslots(first, f.timetable, f.timeslots[1])

	otherDay := f.student("OtherDay", g)
	f.exec("UPDATE students SET preferred_days = '0|2' WHERE id = ?", otherDay)

	// Cooldowns are judged against today (the 3rd), not a session date.
	cooling := f.student("Cooling", g)
	f.exec("UPDATE students SET cooldown_until = '2030-01-05 09:00:00' WHERE id = ?", cooling)

	res := f.queues("1").status(http.StatusOK).object()
	if got := previewQueue(t, res, "Juniors"); !slices.Equal(got, []string{"Last", "First", "Second"}) {
		t.Fatalf("Monday queue = %v, want [Last First Second]", got)
	}

	group := res["groups"].([]any)[0].(map[string]any)
	if group["percentage"] != 100.0 || group["slots"] != nil {
		t.Fatalf("group = %v, want percentage 100 and no slots", group)
	}

	reasons := map[string]any{}
	for _, raw := range group["unavailable"].([]any) {
		e := raw.(map[string]any)
		reasons[e["first_name"].(string)] = e["unavailable"]
	}

	if want := (map[string]any{"OtherDay": "otherDay", "Cooling": "cooldown"}); fmt.Sprint(reasons) != fmt.Sprint(want) {
		t.Fatalf("unavailable = %v, want %v", reasons, want)
	}

	e := previewEntry(t, res, "First")
	if e["schedule"] != nil || fmt.Sprint(e["preferred_timeslots"]) != "[19:00]" {
		t.Fatalf("First = %v, want no schedule and preference [19:00]", e)
	}

	// Without a day, preferred days don't matter.
	if got := previewQueue(t, f.queues("").status(http.StatusOK).object(), "Juniors"); !slices.Equal(got, []string{"Last", "First", "Second", "OtherDay"}) {
		t.Fatalf("all-days queue = %v, want [Last First Second OtherDay]", got)
	}

	// Being on a session's schedule doesn't take anyone out of the queue (their turn moves them
	// back in it, though).
	f.generate().status(http.StatusOK)
	if got := previewQueue(t, f.queues("1").status(http.StatusOK).object(), "Juniors"); len(got) != 3 {
		t.Fatalf("queue after scheduling = %v, want the same 3", got)
	}
}

// Tied members are listed in the order the scheduler uses for the next session to be sent.
func TestTimetableQueuesBreakTiesLikeNextSession(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	for _, name := range []string{"A", "B", "C", "D", "E", "F"} {
		f.student(name, g)
	}

	f.exec("UPDATE student_groups SET joined_at = '2029-01-01 00:00:00'") // all tied

	overview := previewQueue(t, f.queues("").status(http.StatusOK).object(), "Juniors")
	eligible, err := eligibleQueue(f.db, clubLocation(f.srv.db), f.sessionID, sessionDate, f.timetable)
	if err != nil {
		t.Fatal(err)
	}

	var scheduler []string
	for _, c := range eligible {
		scheduler = append(scheduler, c.FirstName)
	}
	if !slices.Equal(overview, scheduler) {
		t.Fatalf("overview order %v, scheduler order %v", overview, scheduler)
	}
}

func TestTimetableQueuesOverride(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("Joined", g)

	// Had a turn after joining: the turn, not the join, sets the position.
	turned := f.student("Turned", g)
	prev := f.session("2029-06-01", f.timetable)
	f.invitation(prev, turned, f.timeslots[0], f.assign(prev, f.instructor("Prev")), g, "confirmed")

	res := f.queues("").status(http.StatusOK).object()
	if o, _ := previewEntry(t, res, "Joined")["queue_override"].(map[string]any); o == nil || o["reason"] != "joined" {
		t.Errorf("Joined queue_override = %v, want joined", o)
	}

	if e := previewEntry(t, res, "Turned"); e["queue_override"] != nil || e["last_turn_at"] != "2029-06-01 00:00:00" {
		t.Fatalf("Turned = %v, want no override and the turn as last_turn_at", e)
	}
}

func TestTimetableQueuesValidation(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	f.public(http.MethodGet, fmt.Sprintf("/api/timetables/%d/queues", f.timetable), nil).
		wantError(http.StatusUnauthorized, "Authentication required")
	f.admin(http.MethodGet, "/api/timetables/999/queues", nil).
		wantError(http.StatusNotFound, "Timetable not found")
	for _, day := range []string{"7", "-1", "monday"} {
		f.queues(day).wantError(http.StatusBadRequest, "day must be a weekday number from 0 (Sunday) to 6")
	}
}
