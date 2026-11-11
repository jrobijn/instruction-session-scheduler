package server

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func groupPath(id int64, rest ...string) string {
	p := fmt.Sprintf("/api/groups/%d", id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func TestGroupCRUD(t *testing.T) {
	e := newTestEnv(t)
	e.admin(http.MethodPost, "/api/groups", map[string]any{}).wantError(http.StatusBadRequest, "Name is required")
	got := e.admin(http.MethodPost, "/api/groups", map[string]any{"name": "Juniors"}).status(http.StatusCreated).object()
	id := toInt64(got["id"])
	if got["color"] != "#3b82f6" || got["new_member_priority"] != "back" || got["is_default"] != 0.0 {
		t.Fatalf("created = %v", got)
	}
	e.admin(http.MethodPost, "/api/groups", map[string]any{"name": "Juniors"}).wantError(http.StatusConflict, "A group with this name already exists")
	e.admin(http.MethodPost, "/api/groups", map[string]any{"name": "Seniors", "color": "#ff0000"}).status(http.StatusCreated)

	got = e.admin(http.MethodPut, groupPath(id), map[string]any{"color": "#000000", "cooldown_member_priority": "front"}).status(http.StatusOK).object()
	if got["name"] != "Juniors" || got["color"] != "#000000" || got["cooldown_member_priority"] != "front" || got["new_member_priority"] != "back" {
		t.Fatalf("updated = %v", got)
	}
	e.admin(http.MethodPut, groupPath(id), map[string]any{"new_member_priority": "middle"}).
		wantError(http.StatusBadRequest, "new_member_priority must be 'front' or 'back'")
	e.admin(http.MethodPut, groupPath(id), map[string]any{"name": "Seniors"}).wantError(http.StatusConflict, "A group with this name already exists")
	e.admin(http.MethodPut, groupPath(999), map[string]any{}).wantError(http.StatusNotFound, "Group not found")

	s := e.student("Ann", id)
	list := e.admin(http.MethodGet, "/api/groups", nil).status(http.StatusOK).array()
	if len(list) != 2 || list[0]["name"] != "Juniors" || list[0]["member_count"] != 1.0 || list[0]["discipline_count"] != 0.0 {
		t.Fatalf("groups = %v", list)
	}

	// A group in a timetable cannot be deleted; otherwise memberships go with it.
	tt, _ := e.timetable("18:00")
	e.timetableGroup(tt, id, 100)
	e.admin(http.MethodDelete, groupPath(id), nil).wantError(http.StatusBadRequest, "Cannot delete a group that is assigned to timetables")
	e.exec("DELETE FROM timetable_groups")
	e.admin(http.MethodDelete, groupPath(id), nil).status(http.StatusOK)
	if e.row("SELECT 1 FROM student_groups WHERE student_id = ?", s) != nil {
		t.Fatal("membership survived the group")
	}
	e.admin(http.MethodDelete, groupPath(id), nil).wantError(http.StatusNotFound, "Group not found")
}

func TestGroupDefault(t *testing.T) {
	e := newTestEnv(t)
	a, b := e.group("A"), e.group("B")
	isDefault := func(id int64) bool {
		return e.row("SELECT is_default FROM groups WHERE id = ?", id)["is_default"] == int64(1)
	}

	e.admin(http.MethodPost, groupPath(a, "set-default"), nil).status(http.StatusOK)
	e.admin(http.MethodPost, groupPath(b, "set-default"), nil).status(http.StatusOK)
	if isDefault(a) || !isDefault(b) {
		t.Fatal("only one group can be the default")
	}
	e.admin(http.MethodPost, groupPath(b, "unset-default"), nil).status(http.StatusOK)
	if isDefault(b) {
		t.Fatal("unset-default left the flag")
	}
	e.admin(http.MethodPost, groupPath(999, "set-default"), nil).wantError(http.StatusNotFound, "Group not found")
	e.admin(http.MethodPost, groupPath(999, "unset-default"), nil).wantError(http.StatusNotFound, "Group not found")
}

func TestGroupMembersEndpoints(t *testing.T) {
	e := newTestEnv(t)
	a, b := e.group("A"), e.group("B")
	s := e.student("Ann", a)

	e.admin(http.MethodPost, groupPath(b, "members"), map[string]any{}).wantError(http.StatusBadRequest, "student_id is required")
	e.admin(http.MethodPost, groupPath(999, "members"), map[string]any{"student_id": s}).wantError(http.StatusNotFound, "Group not found")
	e.admin(http.MethodPost, groupPath(b, "members"), map[string]any{"student_id": 999}).wantError(http.StatusNotFound, "Student not found")

	// Adding to a group moves the student out of their old one.
	e.admin(http.MethodPost, groupPath(b, "members"), map[string]any{"student_id": s}).status(http.StatusOK)
	if m := e.rows("SELECT group_id FROM student_groups WHERE student_id = ?", s); len(m) != 1 || toInt64(m[0]["group_id"]) != b {
		t.Fatalf("memberships = %v", m)
	}

	path := groupPath(b, "members", fmt.Sprint(s), "invite-next")
	e.admin(http.MethodPut, path, map[string]any{}).wantError(http.StatusBadRequest, "enabled (boolean) is required")
	e.admin(http.MethodPut, path, map[string]any{"enabled": "yes"}).wantError(http.StatusBadRequest, "Invalid value for enabled")
	e.admin(http.MethodPut, groupPath(a, "members", fmt.Sprint(s), "invite-next"), map[string]any{"enabled": true}).
		wantError(http.StatusNotFound, "Member not found")
	e.admin(http.MethodPut, path, map[string]any{"enabled": true}).status(http.StatusOK)
	if e.row("SELECT invite_next_at FROM student_groups WHERE student_id = ?", s)["invite_next_at"] == nil {
		t.Fatal("invite-next not set")
	}
	e.admin(http.MethodPut, path, map[string]any{"enabled": false}).status(http.StatusOK)
	if e.row("SELECT invite_next_at FROM student_groups WHERE student_id = ?", s)["invite_next_at"] != nil {
		t.Fatal("invite-next not cleared")
	}

	e.admin(http.MethodDelete, groupPath(b, "members", fmt.Sprint(s)), nil).status(http.StatusOK)
	if e.row("SELECT 1 FROM student_groups WHERE student_id = ?", s) != nil {
		t.Fatal("member not removed")
	}
	e.admin(http.MethodDelete, groupPath(999, "members", fmt.Sprint(s)), nil).wantError(http.StatusNotFound, "Group not found")
}

func TestGroupMembersQueue(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	a := f.student("A", g)
	b := f.student("B", g)
	c := f.student("C", g)
	d := f.student("D", g)
	f.exec("UPDATE students SET active = 0 WHERE id = ?", d)
	f.exec("UPDATE student_groups SET invite_next_at = '2029-12-01 00:00:00' WHERE student_id = ?", c)
	f.buddies(a, b)
	f.invitation(f.sessionID, b, f.timeslots[0], f.slots[0], g, "invited")

	members := f.admin(http.MethodGet, groupPath(g, "members"), nil).status(http.StatusOK).array()
	var order []string
	for _, m := range members {
		order = append(order, fmt.Sprintf("%s:%v", m["first_name"], m["queue_position"]))
	}
	if got := strings.Join(order, ","); got != "C:1,A:2,B:3,D:<nil>" {
		t.Fatalf("queue = %s (invite-next first, inactive last without a position)", got)
	}
	byName := map[string]map[string]any{}
	for _, m := range members {
		byName[m["first_name"].(string)] = m
	}
	if byName["C"]["invite_next"] != true || byName["A"]["invite_next"] != false {
		t.Error("invite_next flags")
	}
	if o, _ := byName["A"]["queue_override"].(map[string]any); o == nil || o["reason"] != "joined" {
		t.Errorf("A queue_override = %v, want joined", byName["A"]["queue_override"])
	}
	bg, _ := byName["A"]["buddy_group"].(map[string]any)
	if bg == nil || bg["name"] != "A & B" || len(bg["buddies"].([]any)) != 1 {
		t.Errorf("A buddy_group = %v", byName["A"]["buddy_group"])
	}
	if byName["B"]["active_invitations"] != 1.0 || byName["A"]["active_invitations"] != 0.0 {
		t.Error("active_invitations counts")
	}
	for _, k := range []string{"queue_at", "invite_next_pending_since", "joined_at", "new_policy", "buddy_group_id"} {
		if _, leaked := byName["A"][k]; leaked {
			t.Errorf("internal column %s leaked", k)
		}
	}
	f.admin(http.MethodGet, groupPath(999, "members"), nil).wantError(http.StatusNotFound, "Group not found")
}

// Tied members are listed in the order the scheduler uses for the next session to be sent.
func TestGroupMembersBreakTiesLikeNextSession(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	for _, name := range []string{"A", "B", "C", "D", "E", "F"} {
		f.student(name, g)
	}
	f.exec("UPDATE student_groups SET joined_at = '2029-01-01 00:00:00'") // all tied

	var overview []string
	for _, m := range f.admin(http.MethodGet, groupPath(g, "members"), nil).status(http.StatusOK).array() {
		overview = append(overview, m["first_name"].(string))
	}
	eligible, err := eligibleQueue(f.db, f.srv.clubLocation(), f.sessionID, sessionDate, f.timetable)
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

func TestGroupMembersQueueOverrideOnlyWhenItPlacesMember(t *testing.T) {
	// Had a turn after joining: the turn, not the join, sets the position.
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	a := f.student("A", g)
	prev := f.session("2029-06-01", f.timetable)
	f.invitation(prev, a, f.timeslots[0], f.assign(prev, f.instructor("Prev")), g, "confirmed")

	m := f.admin(http.MethodGet, groupPath(g, "members"), nil).status(http.StatusOK).array()[0]
	if m["queue_override"] != nil || m["last_turn_at"] != "2029-06-01 00:00:00" {
		t.Fatalf("member = %v", m)
	}
}

func TestGroupNonMembers(t *testing.T) {
	e := newTestEnv(t)
	a, b := e.group("A"), e.group("B")
	e.student("Ann", a)
	e.student("Bob", b)
	e.exec("INSERT INTO students (first_name, last_name, email) VALUES ('Cy', 'Test', 'cy@example.test')")

	if got := e.admin(http.MethodGet, groupPath(a, "non-members")+"?q=", nil).status(http.StatusOK).array(); len(got) != 0 {
		t.Fatalf("empty query = %v", got)
	}
	got := e.admin(http.MethodGet, groupPath(a, "non-members")+"?q=Test", nil).status(http.StatusOK).array()
	if len(got) != 2 || got[0]["first_name"] != "Bob" || got[0]["current_group_name"] != "B" || got[1]["current_group_name"] != nil {
		t.Fatalf("non-members = %v", got)
	}
	e.admin(http.MethodGet, groupPath(999, "non-members")+"?q=x", nil).wantError(http.StatusNotFound, "Group not found")
}

func TestGroupDisciplines(t *testing.T) {
	e := newTestEnv(t)
	g := e.exec("INSERT INTO groups (name) VALUES ('Bare')")
	d := e.discipline("Kayak")
	path := groupPath(g, "disciplines", fmt.Sprint(d))

	e.admin(http.MethodPost, path, nil).status(http.StatusOK)
	e.admin(http.MethodPost, path, nil).wantError(http.StatusConflict, "Already assigned")
	e.admin(http.MethodPost, groupPath(g, "disciplines", "999"), nil).wantError(http.StatusNotFound, "Discipline not found")
	e.admin(http.MethodPost, groupPath(999, "disciplines", fmt.Sprint(d)), nil).wantError(http.StatusNotFound, "Group not found")
	if got := e.admin(http.MethodGet, groupPath(g, "disciplines"), nil).status(http.StatusOK).array(); len(got) != 1 || got[0]["name"] != "Kayak" {
		t.Fatalf("disciplines = %v", got)
	}
	e.admin(http.MethodDelete, path, nil).status(http.StatusOK)
	if got := e.admin(http.MethodGet, groupPath(g, "disciplines"), nil).status(http.StatusOK).array(); len(got) != 0 {
		t.Fatalf("disciplines after removal = %v", got)
	}
	e.admin(http.MethodGet, groupPath(999, "disciplines"), nil).wantError(http.StatusNotFound, "Group not found")
	e.admin(http.MethodDelete, groupPath(999, "disciplines", "1"), nil).wantError(http.StatusNotFound, "Group not found")
}

func TestGroupImportExport(t *testing.T) {
	e := newTestEnv(t)
	e.group("Existing")
	res := e.admin(http.MethodPost, "/api/groups/import", map[string]any{"csv": "Name,color\nNew,red\nExisting,blue\n,x\n\"With, comma\""}).
		status(http.StatusOK).object()
	if res["imported"] != 2.0 || res["skipped"] != 2.0 || fmt.Sprint(res["errors"]) != "[Row 4: missing name]" {
		t.Fatalf("import = %v", res)
	}
	e.admin(http.MethodPost, "/api/groups/import", map[string]any{"csv": "title\nx"}).wantError(http.StatusBadRequest, "CSV must contain a name column")

	body := string(e.admin(http.MethodGet, "/api/groups/export", nil).status(http.StatusOK).Body)
	if want := "name,is_default,active\nExisting,0,1\nNew,0,1\n\"With, comma\",0,1"; body != want {
		t.Fatalf("export = %q, want %q", body, want)
	}
}
