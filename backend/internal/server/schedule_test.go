package server

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"testing"
)

// sessionDate is a Monday (day 1).
const sessionDate = "2030-01-07"

type scheduleFixture struct {
	*testEnv
	timetable int64
	timeslots []int64 // ids, in start-time order
	sessionID int64
	slots     []int64 // session_slots ids, one per instructor
}

// newScheduleFixture creates a session on sessionDate whose timetable has the given start
// times and `instructors` assigned instructors. Groups and students are added per test.
func newScheduleFixture(t *testing.T, startTimes []string, instructors int) *scheduleFixture {
	t.Helper()
	e := newTestEnv(t)
	tt, ts := e.timetable(startTimes...)
	f := &scheduleFixture{testEnv: e, timetable: tt, timeslots: ts, sessionID: e.session(sessionDate, tt)}
	for i := range instructors {
		f.slots = append(f.slots, e.assign(f.sessionID, e.instructor(fmt.Sprintf("Instructor%c", 'A'+i))))
	}

	return f
}

// groupIn creates a group linked to the fixture's timetable with the given percentage.
func (f *scheduleFixture) groupIn(name string, percentage int) int64 {
	f.t.Helper()
	gid := f.group(name)
	f.timetableGroup(f.timetable, gid, percentage)
	return gid
}

func (f *scheduleFixture) generate() *response {
	f.t.Helper()
	return f.admin(http.MethodPost, fmt.Sprintf("/api/sessions/%d/generate-schedule", f.sessionID), nil)
}

type placement struct {
	Start string
	Slot  int64
}

// placements maps first names of invited students to where they were placed.
func (f *scheduleFixture) placements() map[string]placement {
	f.t.Helper()
	out := map[string]placement{}
	for _, r := range f.invitationRows() {
		name := r["first_name"].(string)
		if _, dup := out[name]; dup {
			f.t.Fatalf("%s invited twice", name)
		}

		out[name] = placement{r["start_time"].(string), toInt64(r["slot_id"])}
	}

	return out
}

func (f *scheduleFixture) invitationRows() []map[string]any {
	f.t.Helper()
	return f.rows(`
		SELECT inv.*, s.first_name, t.start_time FROM invitations inv
		JOIN students s ON s.id = inv.student_id
		JOIN timeslots t ON t.id = inv.timeslot_id
		WHERE inv.session_id = ?
		ORDER BY t.start_time, inv.slot_id`, f.sessionID)
}

func (f *scheduleFixture) decisionLog(firstName string) map[string]any {
	f.t.Helper()
	for _, r := range f.invitationRows() {
		if r["first_name"] == firstName {
			var log map[string]any
			if err := json.Unmarshal([]byte(r["decision_log"].(string)), &log); err != nil {
				f.t.Fatalf("decision_log of %s: %v", firstName, err)
			}

			return log
		}
	}

	f.t.Fatalf("%s not invited", firstName)
	return nil
}

func invitedNames(p map[string]placement) []string {
	return slices.Sorted(maps.Keys(p))
}

func wantInvited(t *testing.T, p map[string]placement, want ...string) {
	t.Helper()
	slices.Sort(want)
	if got := invitedNames(p); !slices.Equal(got, want) {
		t.Fatalf("invited = %v, want %v", got, want)
	}
}

func wantStart(t *testing.T, p map[string]placement, name, start string) {
	t.Helper()
	if got, ok := p[name]; !ok || got.Start != start {
		t.Fatalf("%s placed at %+v (invited: %v), want start %s", name, got, ok, start)
	}
}

// --- validation -------------------------------------------------------------------------

func TestGenerateScheduleValidation(t *testing.T) {
	t.Run("requires authentication", func(t *testing.T) {
		f := newScheduleFixture(t, []string{"18:00"}, 1)
		f.public(http.MethodPost, fmt.Sprintf("/api/sessions/%d/generate-schedule", f.sessionID), nil).
			wantError(http.StatusUnauthorized, "Authentication required")
	})

	t.Run("unknown session", func(t *testing.T) {
		e := newTestEnv(t)
		e.admin(http.MethodPost, "/api/sessions/999/generate-schedule", nil).
			wantError(http.StatusNotFound, "Training session not found")
	})

	t.Run("no timetable", func(t *testing.T) {
		e := newTestEnv(t)
		id := e.session(sessionDate, 0)
		e.admin(http.MethodPost, fmt.Sprintf("/api/sessions/%d/generate-schedule", id), nil).
			wantError(http.StatusBadRequest, "No timetable attached to this session")
	})

	t.Run("no instructors", func(t *testing.T) {
		f := newScheduleFixture(t, []string{"18:00"}, 0)
		f.generate().wantError(http.StatusBadRequest, "No instructors assigned for this session")
	})

	t.Run("removed instructors do not count", func(t *testing.T) {
		f := newScheduleFixture(t, []string{"18:00"}, 1)
		f.exec("UPDATE session_slots SET removed = 1")
		f.generate().wantError(http.StatusBadRequest, "No instructors assigned for this session")
	})

	t.Run("no timeslots", func(t *testing.T) {
		f := newScheduleFixture(t, nil, 1)
		f.generate().wantError(http.StatusBadRequest, "No timeslots defined in the attached timetable")
	})

	t.Run("no groups", func(t *testing.T) {
		f := newScheduleFixture(t, []string{"18:00"}, 1)
		f.generate().wantError(http.StatusBadRequest, "No groups assigned to this timetable")
	})

	t.Run("no eligible students", func(t *testing.T) {
		f := newScheduleFixture(t, []string{"18:00"}, 1)
		f.groupIn("Empty", 100)
		f.generate().wantError(http.StatusBadRequest,
			"No eligible students found. Ensure students have group memberships with access to disciplines.")
	})
}

// --- basic placement --------------------------------------------------------------------

func TestGenerateScheduleFillsGridInQueueOrder(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 2)
	g := f.groupIn("Juniors", 100)
	for _, name := range []string{"S1", "S2", "S3", "S4", "S5", "S6"} {
		f.student(name, g)
	}

	res := f.generate().status(http.StatusOK).object()
	if res["total_slots"] != 4.0 || res["students_invited"] != 4.0 {
		t.Fatalf("total_slots = %v, students_invited = %v, want 4 and 4", res["total_slots"], res["students_invited"])
	}
	if n := len(res["invitations"].([]any)); n != 4 {
		t.Fatalf("response lists %d invitations, want 4", n)
	}

	p := f.placements()
	wantInvited(t, p, "S1", "S2", "S3", "S4")

	// Without preferences, students fill the earliest timeslot first, in queue order.
	wantStart(t, p, "S1", "18:00")
	wantStart(t, p, "S2", "18:00")
	wantStart(t, p, "S3", "19:00")
	wantStart(t, p, "S4", "19:00")

	spots := map[placement]bool{}
	for _, pl := range p {
		if spots[pl] {
			t.Fatalf("spot %+v assigned twice", pl)
		}

		spots[pl] = true
	}

	for _, r := range f.invitationRows() {
		if r["status"] != "scheduled" || toInt64(r["group_id"]) != g {
			t.Fatalf("invitation %v: status %v group %v, want scheduled in group %d", r["first_name"], r["status"], r["group_id"], g)
		}
	}
	if st := f.row("SELECT status FROM training_sessions WHERE id = ?", f.sessionID)["status"]; st != "scheduled" {
		t.Fatalf("session status = %v, want scheduled", st)
	}
}

func TestGenerateScheduleRecentTurnGoesToBack(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	recent := f.student("Recent", g)
	f.student("Waiting", g)

	// Recent joined first but had a turn after Waiting joined.
	prev := f.session("2029-06-01", f.timetable)
	f.invitation(prev, recent, f.timeslots[0], f.assign(prev, f.instructor("Prev")), g, "confirmed")

	f.generate().status(http.StatusOK)
	wantInvited(t, f.placements(), "Waiting")
}

func TestGenerateScheduleUncountedTurnKeepsPlace(t *testing.T) {
	// A declined invitation does not count as a turn.
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	declined := f.student("Declined", g)
	f.student("Waiting", g)
	prev := f.session("2029-06-01", f.timetable)
	f.invitation(prev, declined, f.timeslots[0], f.assign(prev, f.instructor("Prev")), g, "declined")

	f.generate().status(http.StatusOK)
	wantInvited(t, f.placements(), "Declined")
}

func TestGenerateScheduleInviteNextJumpsQueue(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("First", g)
	f.student("Second", g)
	last := f.student("Last", g)
	f.exec("UPDATE student_groups SET invite_next_at = '2029-12-01 00:00:00' WHERE student_id = ?", last)

	f.generate().status(http.StatusOK)
	wantInvited(t, f.placements(), "Last")
	if f.decisionLog("Last")["invite_next"] != true {
		t.Fatal("decision log should record invite_next")
	}
}

func TestGenerateScheduleNewMemberPriority(t *testing.T) {
	// Veteran had a turn on 2029-06-01; Newcomer joined after that. With 'back' the newcomer
	// queues from their join date, with 'front' they skip ahead.
	for _, tc := range []struct{ policy, want string }{{"back", "Veteran"}, {"front", "Newcomer"}} {
		t.Run(tc.policy, func(t *testing.T) {
			f := newScheduleFixture(t, []string{"18:00"}, 1)
			g := f.groupIn("Juniors", 100)
			f.exec("UPDATE groups SET new_member_priority = ? WHERE id = ?", tc.policy, g)
			veteran := f.student("Veteran", g)
			newcomer := f.student("Newcomer", g)
			f.exec("UPDATE student_groups SET joined_at = '2029-12-01 00:00:00' WHERE student_id = ?", newcomer)
			prev := f.session("2029-06-01", f.timetable)
			f.invitation(prev, veteran, f.timeslots[0], f.assign(prev, f.instructor("Prev")), g, "confirmed")

			f.generate().status(http.StatusOK)
			wantInvited(t, f.placements(), tc.want)
		})
	}
}

// --- eligibility ------------------------------------------------------------------------

func TestGenerateScheduleEligibility(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00", "20:00", "21:00", "22:00", "23:00", "23:30"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("Eligible", g)

	inactive := f.student("Inactive", g)
	f.exec("UPDATE students SET active = 0 WHERE id = ?", inactive)

	deleted := f.student("Deleted", g)
	f.exec("UPDATE students SET deleted_at = datetime('now') WHERE id = ?", deleted)

	cooling := f.student("CoolingDown", g)
	f.exec("UPDATE students SET cooldown_until = '2030-01-08 09:00:00' WHERE id = ?", cooling)

	cooled := f.student("CooldownOver", g)
	f.exec("UPDATE students SET cooldown_until = '2030-01-06 12:00:00' WHERE id = ?", cooled)

	// The cooldown endpoint stores a time; a cooldown ending during the session day is over.
	coolingUntilAfternoon := f.student("CooldownEndsThatDay", g)
	f.exec("UPDATE students SET cooldown_until = '2030-01-07 15:30:00' WHERE id = ?", coolingUntilAfternoon)

	// Cooldowns are stored in UTC but end on a club-timezone day: 23:30 UTC on the session date
	// is 00:30 the next day in Europe/Amsterdam (the default timezone), so not over yet.
	coolingPastMidnight := f.student("CooldownEndsAfterMidnightLocally", g)
	f.exec("UPDATE students SET cooldown_until = '2030-01-07 23:30:00' WHERE id = ?", coolingPastMidnight)

	// A declined (manual) invitation to this session is kept, and its student is not invited again.
	declined := f.student("DeclinedThisSession", g)
	f.invitation(f.sessionID, declined, f.timeslots[0], f.slots[0], 0, "declined")

	otherDays := f.student("OtherDays", g) // session is on day 1
	f.exec("UPDATE students SET preferred_days = '0|2|3|4|5|6' WHERE id = ?", otherDays)

	// A group in the timetable whose only discipline is inactive.
	inactiveDiscipline := f.groupIn("NoDiscipline", 0)
	f.exec("UPDATE disciplines SET active = 0 WHERE id IN (SELECT discipline_id FROM discipline_groups WHERE group_id = ?)", inactiveDiscipline)
	f.student("NoActiveDiscipline", inactiveDiscipline)

	// A group that is not in the timetable.
	f.student("OtherGroup", f.group("Elsewhere"))

	f.generate().status(http.StatusOK)

	// DeclinedThisSession is listed for the kept declined invitation; placements fails on a second one.
	wantInvited(t, f.placements(), "Eligible", "CooldownOver", "CooldownEndsThatDay", "DeclinedThisSession")
}

// --- group quotas and overflow ----------------------------------------------------------

func TestGenerateScheduleGroupQuotas(t *testing.T) {
	// 3 spots split 50/50: one each, the remainder goes to the first group by position.
	f := newScheduleFixture(t, []string{"18:00", "19:00", "20:00"}, 1)
	a := f.groupIn("A", 50)
	b := f.groupIn("B", 50)
	for _, n := range []string{"A1", "A2", "A3"} {
		f.student(n, a)
	}

	for _, n := range []string{"B1", "B2", "B3"} {
		f.student(n, b)
	}

	f.generate().status(http.StatusOK)
	wantInvited(t, f.placements(), "A1", "A2", "B1")
	if q := f.decisionLog("A1")["group_quota"]; q != "2 slots (50%)" {
		t.Fatalf("A quota = %v", q)
	}
	if q := f.decisionLog("B1")["group_quota"]; q != "1 slots (50%)" {
		t.Fatalf("B quota = %v", q)
	}
	if f.decisionLog("B1")["overflow"] != false {
		t.Fatal("B1 was selected by quota, not overflow")
	}
}

func TestGenerateScheduleOverflowFillsUnusedQuota(t *testing.T) {
	// A's quota is 2 but it has a single student; its unused spot overflows to B.
	f := newScheduleFixture(t, []string{"18:00", "19:00", "20:00", "21:00"}, 1)
	a := f.groupIn("A", 50)
	b := f.groupIn("B", 50)
	f.student("A1", a)
	for _, n := range []string{"B1", "B2", "B3", "B4"} {
		f.student(n, b)
	}

	f.generate().status(http.StatusOK)
	wantInvited(t, f.placements(), "A1", "B1", "B2", "B3")
	log := f.decisionLog("B3")
	if log["overflow"] != true || log["group_quota"] != "" {
		t.Fatalf("B3 decision log = %v, want overflow without quota", log)
	}
}

// --- timeslot preferences ---------------------------------------------------------------

func TestGenerateSchedulePreferenceHonoured(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("Flexible", g) // ahead in the queue
	picky := f.student("Picky", g)
	f.preferTimeslots(picky, f.timetable, f.timeslots[0])

	f.generate().status(http.StatusOK)
	p := f.placements()
	wantStart(t, p, "Picky", "18:00")
	wantStart(t, p, "Flexible", "19:00")
	if got := f.decisionLog("Picky")["preferred_timeslots"]; !slices.Equal(got.([]any), []any{"18:00"}) {
		t.Fatalf("preferred_timeslots = %v", got)
	}
	if got := f.decisionLog("Flexible")["preferred_timeslots"]; got != nil {
		t.Fatalf("preferred_timeslots without preferences = %v, want null", got)
	}
}

func TestGenerateScheduleMovesPlacedStudentForPreference(t *testing.T) {
	// A takes 18:00 first; B can only do 18:00, so A is moved to their other option.
	f := newScheduleFixture(t, []string{"18:00", "19:00", "20:00"}, 1)
	g := f.groupIn("Juniors", 100)
	a := f.student("A", g)
	b := f.student("B", g)
	f.preferTimeslots(a, f.timetable, f.timeslots[0], f.timeslots[1])
	f.preferTimeslots(b, f.timetable, f.timeslots[0])

	f.generate().status(http.StatusOK)
	p := f.placements()
	wantStart(t, p, "A", "19:00")
	wantStart(t, p, "B", "18:00")
}

func TestGenerateScheduleReplacesUnplaceableStudent(t *testing.T) {
	// Quota 2 selects A and B, who both only fit 18:00. B can't be placed and is replaced by
	// the next candidate of the group.
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	a := f.student("A", g)
	b := f.student("B", g)
	f.student("C", g)
	f.preferTimeslots(a, f.timetable, f.timeslots[0])
	f.preferTimeslots(b, f.timetable, f.timeslots[0])

	f.generate().status(http.StatusOK)
	p := f.placements()
	wantInvited(t, p, "A", "C")
	wantStart(t, p, "A", "18:00")
	wantStart(t, p, "C", "19:00")
}

func TestGenerateSchedulePreferencesOfOtherTimetablesIgnored(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("First", g)
	s := f.student("Second", g)
	otherTT, otherSlots := f.testEnv.timetable("18:00")
	f.preferTimeslots(s, otherTT, otherSlots[0])

	f.generate().status(http.StatusOK)
	p := f.placements()
	wantStart(t, p, "First", "18:00")
	wantStart(t, p, "Second", "19:00")
}

// --- buddies ----------------------------------------------------------------------------

func TestGenerateScheduleBuddyPulledUp(t *testing.T) {
	// Quota 2: A is selected first and pulls up their buddy D ahead of B and C.
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	a := f.student("A", g)
	f.student("B", g)
	f.student("C", g)
	d := f.student("D", g)
	f.buddies(a, d)

	f.generate().status(http.StatusOK)
	wantInvited(t, f.placements(), "A", "D")
	if near := f.decisionLog("D")["buddy_placed_near"]; near != "A Test" {
		t.Fatalf("buddy_placed_near = %v, want %q", near, "A Test")
	}
	if near := f.decisionLog("A")["buddy_placed_near"]; near != "" {
		t.Fatalf("A buddy_placed_near = %v, want empty", near)
	}
}

func TestGenerateScheduleBuddyPlacedInNearestTimeslot(t *testing.T) {
	// A prefers 20:00. Their buddy B has no preference and is placed as close to A as possible
	// (20:00 itself, with two instructors), not in the earliest free timeslot.
	f := newScheduleFixture(t, []string{"18:00", "19:00", "20:00"}, 2)
	g := f.groupIn("Juniors", 100)
	a := f.student("A", g)
	b := f.student("B", g)
	f.preferTimeslots(a, f.timetable, f.timeslots[2])
	f.buddies(a, b)

	f.generate().status(http.StatusOK)
	p := f.placements()
	wantStart(t, p, "A", "20:00")
	wantStart(t, p, "B", "20:00")
}

func TestGenerateScheduleBuddyInOtherGroupNotPulledUp(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	a := f.groupIn("A", 50)
	b := f.groupIn("B", 50)
	a1 := f.student("A1", a)
	f.student("A2", a)
	f.student("B1", b)
	b2 := f.student("B2", b)
	f.buddies(a1, b2)

	f.generate().status(http.StatusOK)
	wantInvited(t, f.placements(), "A1", "B1")
}

// --- manual invitations and regeneration ------------------------------------------------

func TestGenerateScheduleKeepsManualInvitations(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	manual := f.student("Manual", g)
	f.student("A", g)
	f.student("B", g)
	manualID := f.invitation(f.sessionID, manual, f.timeslots[0], f.slots[0], 0, "scheduled")
	manualToken := f.row("SELECT token FROM invitations WHERE id = ?", manualID)["token"]

	for run := 1; run <= 2; run++ {
		res := f.generate().status(http.StatusOK).object()
		if res["students_invited"] != 2.0 {
			t.Fatalf("run %d: students_invited = %v, want 2 (manual + A)", run, res["students_invited"])
		}

		p := f.placements()
		wantInvited(t, p, "Manual", "A")
		wantStart(t, p, "Manual", "18:00")
		wantStart(t, p, "A", "19:00")
		if tok := f.row("SELECT token FROM invitations WHERE id = ?", manualID)["token"]; tok != manualToken {
			t.Fatalf("run %d: manual invitation was replaced", run)
		}
	}
}

func TestGenerateScheduleIsDeterministic(t *testing.T) {
	// All students tie in the queue, so the order comes from the per-session tie breaker.
	f := newScheduleFixture(t, []string{"18:00", "19:00", "20:00"}, 2)
	a := f.groupIn("A", 60)
	b := f.groupIn("B", 40)
	for i := range 6 {
		f.student(fmt.Sprintf("A%d", i), a)
		f.student(fmt.Sprintf("B%d", i), b)
	}

	f.exec("UPDATE student_groups SET joined_at = NULL")

	f.generate().status(http.StatusOK)
	first := f.placements()
	if len(first) != 6 {
		t.Fatalf("invited %d, want 6", len(first))
	}

	f.generate().status(http.StatusOK)
	if second := f.placements(); !maps.Equal(first, second) {
		t.Fatalf("regenerating changed the schedule:\n first  %v\n second %v", first, second)
	}
}

func TestGenerateScheduleFailedRegenerationKeepsSchedule(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("A", g)
	f.generate().status(http.StatusOK)
	before := f.invitationRows()

	f.exec("UPDATE students SET active = 0")
	f.generate().wantError(http.StatusBadRequest,
		"No eligible students found. Ensure students have group memberships with access to disciplines.")
	after := f.invitationRows()
	if len(after) != 1 || after[0]["token"] != before[0]["token"] {
		t.Fatalf("schedule after a failed regeneration = %v, want it unchanged", after)
	}
	if st := f.sessionStatus(f.sessionID); st != "scheduled" {
		t.Fatalf("session status = %s", st)
	}
}

// --- preview ----------------------------------------------------------------------------

func (f *scheduleFixture) preview() *response {
	f.t.Helper()
	return f.admin(http.MethodGet, fmt.Sprintf("/api/sessions/%d/schedule-preview", f.sessionID), nil)
}

// previewQueue lists a preview group's queue, by group name, as first names; invited ones
// get a "+" suffix.
func previewQueue(t *testing.T, res map[string]any, group string) []string {
	t.Helper()
	for _, raw := range res["groups"].([]any) {
		g := raw.(map[string]any)
		if g["group_name"] != group {
			continue
		}

		out := []string{}
		for i, rawEntry := range g["queue"].([]any) {
			e := rawEntry.(map[string]any)
			if e["queue_position"] != float64(i+1) {
				t.Fatalf("%s: position %v at index %d", e["first_name"], e["queue_position"], i)
			}

			name := e["first_name"].(string)
			if scheduled(e)["invited"] == true {
				name += "+"
			}

			out = append(out, name)
		}

		return out
	}

	t.Fatalf("no group %s in preview", group)
	return nil
}

// scheduled returns what a preview entry says generating would do with the student.
func scheduled(e map[string]any) map[string]any {
	s, _ := e["schedule"].(map[string]any)
	return s
}

// previewEntry finds a student in a preview by first name.
func previewEntry(t *testing.T, res map[string]any, firstName string) map[string]any {
	t.Helper()
	for _, raw := range res["groups"].([]any) {
		for _, rawEntry := range raw.(map[string]any)["queue"].([]any) {
			if e := rawEntry.(map[string]any); e["first_name"] == firstName {
				return e
			}
		}
	}

	t.Fatalf("%s not in preview", firstName)
	return nil
}

func TestSchedulePreviewMatchesGenerate(t *testing.T) {
	// Ties, two groups, overflow and a buddy: everything that decides who is invited.
	f := newScheduleFixture(t, []string{"18:00", "19:00", "20:00"}, 2)
	a := f.groupIn("A", 60)
	b := f.groupIn("B", 40)
	var ids []int64
	for i := range 7 {
		ids = append(ids, f.student(fmt.Sprintf("A%d", i), a))
	}

	f.student("B0", b) // B's quota is 2: one spot overflows

	f.exec("UPDATE student_groups SET joined_at = NULL")
	f.buddies(ids[0], ids[6])

	res := f.preview().status(http.StatusOK).object()
	if rows := f.invitationRows(); len(rows) != 0 {
		t.Fatalf("preview wrote %d invitations", len(rows))
	}
	if st := f.sessionStatus(f.sessionID); st != "draft" {
		t.Fatalf("session status after preview = %s, want draft", st)
	}

	var previewed []string
	for _, g := range []string{"A", "B"} {
		for _, name := range previewQueue(t, res, g) {
			if n, ok := strings.CutSuffix(name, "+"); ok {
				previewed = append(previewed, n)
			}
		}
	}

	gen := f.generate().status(http.StatusOK).object()
	wantInvited(t, f.placements(), previewed...)
	if res["total_slots"] != gen["total_slots"] || res["students_invited"] != gen["students_invited"] {
		t.Fatalf("preview counts %v/%v, generated %v/%v", res["total_slots"], res["students_invited"], gen["total_slots"], gen["students_invited"])
	}

	for _, raw := range res["groups"].([]any) {
		g := raw.(map[string]any)
		if g["group_name"] == "A" && g["slots"] != 4.0 {
			t.Fatalf("A has %v slots, want 4", g["slots"])
		}
	}

	if e := scheduled(previewEntry(t, res, "B0")); e["invited"] != true || e["overflow"] != false {
		t.Fatalf("B0 = %v, want invited within quota", e)
	}

	overflow := 0
	for _, raw := range res["groups"].([]any) {
		for _, rawEntry := range raw.(map[string]any)["queue"].([]any) {
			if scheduled(rawEntry.(map[string]any))["overflow"] == true {
				overflow++
			}
		}
	}

	if overflow != 1 {
		t.Fatalf("%d overflow invitations, want 1", overflow)
	}
}

func TestSchedulePreviewQueue(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	first := f.student("First", g)
	f.student("Second", g)
	last := f.student("Last", g)
	f.exec("UPDATE student_groups SET invite_next_at = '2029-12-01 00:00:00' WHERE student_id = ?", last)

	// Not available for this session: they are listed apart, with the reason.
	otherDay := f.student("OtherDay", g)
	f.exec("UPDATE students SET preferred_days = '0|2' WHERE id = ?", otherDay)
	cooling := f.student("Cooling", g)
	f.exec("UPDATE students SET cooldown_until = '2030-01-08 09:00:00' WHERE id = ?", cooling)
	inactive := f.student("Inactive", g)
	f.exec("UPDATE students SET active = 0 WHERE id = ?", inactive)

	// Buddies: one in the queue, the others away for a reason.
	other := f.group("Elsewhere")
	away := f.student("Away", other)
	f.buddies(first, otherDay, cooling, away)

	res := f.preview().status(http.StatusOK).object()
	if got, want := previewQueue(t, res, "Juniors"), []string{"Last+", "First", "Second"}; !slices.Equal(got, want) {
		t.Fatalf("queue = %v, want %v", got, want)
	}

	if e := previewEntry(t, res, "Last"); e["invite_next"] != true {
		t.Fatalf("Last: invite_next = %v", e["invite_next"])
	}

	apart := map[string]any{}
	for _, raw := range previewEntry(t, res, "First")["buddies"].([]any) {
		b := raw.(map[string]any)
		apart[b["first_name"].(string)] = b["apart"]
	}

	want := map[string]any{"OtherDay": "otherDay", "Cooling": "cooldown", "Away": "otherGroup"}
	if !maps.Equal(apart, want) {
		t.Fatalf("buddies of First = %v, want %v", apart, want)
	}

	unavailable := map[string]any{}
	for _, raw := range res["groups"].([]any) {
		for _, rawEntry := range raw.(map[string]any)["unavailable"].([]any) {
			e := rawEntry.(map[string]any)
			if e["queue_position"] != nil || e["schedule"] != nil {
				t.Fatalf("unavailable %s: position %v, schedule %v", e["first_name"], e["queue_position"], e["schedule"])
			}

			unavailable[e["first_name"].(string)] = e["unavailable"]
		}
	}

	wantUnavailable := map[string]any{"OtherDay": "otherDay", "Cooling": "cooldown", "Inactive": "inactive"}
	if !maps.Equal(unavailable, wantUnavailable) {
		t.Fatalf("unavailable = %v, want %v", unavailable, wantUnavailable)
	}
}

func TestSchedulePreviewTimeslotPreferences(t *testing.T) {
	// First and Second both only want 18:00, which has one spot: Second is skipped and Third
	// takes their spot at 19:00.
	f := newScheduleFixture(t, []string{"18:00", "19:00"}, 1)
	g := f.groupIn("Juniors", 100)
	first := f.student("First", g)
	second := f.student("Second", g)
	f.student("Third", g)
	f.preferTimeslots(first, f.timetable, f.timeslots[0])
	f.preferTimeslots(second, f.timetable, f.timeslots[0])

	res := f.preview().status(http.StatusOK).object()
	var starts []string
	for _, raw := range res["timeslots"].([]any) {
		starts = append(starts, raw.(map[string]any)["start_time"].(string))
	}

	if !slices.Equal(starts, []string{"18:00", "19:00"}) {
		t.Fatalf("timeslots = %v, want the timetable's [18:00 19:00]", starts)
	}

	if got := previewQueue(t, res, "Juniors"); !slices.Equal(got, []string{"First+", "Second", "Third+"}) {
		t.Fatalf("queue = %v, want [First+ Second Third+]", got)
	}

	e := previewEntry(t, res, "First")
	if scheduled(e)["start_time"] != "18:00" || fmt.Sprint(e["preferred_timeslots"]) != "[18:00]" || scheduled(e)["skipped"] != false {
		t.Fatalf("First = %v, want invited at 18:00 with preference [18:00]", e)
	}

	e = previewEntry(t, res, "Second")
	if scheduled(e)["skipped"] != true || scheduled(e)["start_time"] != nil {
		t.Fatalf("Second = %v, want skipped", e)
	}

	e = previewEntry(t, res, "Third")
	if scheduled(e)["start_time"] != "19:00" || e["preferred_timeslots"] != nil {
		t.Fatalf("Third = %v, want at 19:00 without preference", e)
	}
}

func TestSchedulePreviewOfScheduledSession(t *testing.T) {
	// Students on the current schedule are not "already invited" in the preview, as
	// regenerating replaces their invitations; and the schedule itself stays.
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	f.student("A", g)
	f.student("B", g)
	f.generate().status(http.StatusOK)
	before := f.invitationRows()

	if got := previewQueue(t, f.preview().status(http.StatusOK).object(), "Juniors"); !slices.Equal(got, []string{"A+", "B"}) {
		t.Fatalf("queue = %v, want [A+ B]", got)
	}

	after := f.invitationRows()
	if len(after) != 1 || after[0]["token"] != before[0]["token"] {
		t.Fatalf("schedule after preview = %v, want it unchanged", after)
	}
}

func TestSchedulePreviewValidation(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	f.public(http.MethodGet, fmt.Sprintf("/api/sessions/%d/schedule-preview", f.sessionID), nil).
		wantError(http.StatusUnauthorized, "Authentication required")
	f.admin(http.MethodGet, "/api/sessions/999/schedule-preview", nil).
		wantError(http.StatusNotFound, "Training session not found")
	f.preview().wantError(http.StatusBadRequest, "No groups assigned to this timetable")

	f.exec("UPDATE training_sessions SET status = 'invitations_sent'")
	f.preview().wantError(http.StatusBadRequest, "A schedule can only be generated before invitations are sent")
}

func TestGenerateScheduleRefusedAfterInvitationsSent(t *testing.T) {
	for _, status := range []string{"invitations_sent", "completed", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			f, _ := invitedPair(t)
			f.invitationAction("A", "confirm", map[string]any{}).status(http.StatusOK)
			f.exec("UPDATE training_sessions SET status = ? WHERE id = ?", status, f.sessionID)
			before := f.invitationRows()

			f.generate().wantError(http.StatusBadRequest, "A schedule can only be generated before invitations are sent")
			after := f.invitationRows()
			if len(after) != len(before) {
				t.Fatalf("%d invitations, want %d", len(after), len(before))
			}
			for i := range after {
				if after[i]["token"] != before[i]["token"] || after[i]["status"] != before[i]["status"] {
					t.Fatalf("invitation changed: %v -> %v", before[i], after[i])
				}
			}
			if st := f.sessionStatus(f.sessionID); st != status {
				t.Fatalf("session status = %s, want %s", st, status)
			}
		})
	}
}
