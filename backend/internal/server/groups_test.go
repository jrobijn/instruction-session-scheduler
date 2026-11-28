package server

import (
	"fmt"
	"maps"
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

	e.admin(http.MethodPost, groupPath(a, "set-default"), nil).status(http.StatusOK)
	e.admin(http.MethodPost, groupPath(999, "set-default"), nil).wantError(http.StatusNotFound, "Group not found")
	if !isDefault(a) {
		t.Fatal("setting a missing group as default cleared the existing default")
	}

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

	e.admin(http.MethodDelete, groupPath(b, "members", fmt.Sprint(s)), nil).status(http.StatusOK)
	if e.row("SELECT 1 FROM student_groups WHERE student_id = ?", s) != nil {
		t.Fatal("member not removed")
	}

	e.admin(http.MethodDelete, groupPath(999, "members", fmt.Sprint(s)), nil).wantError(http.StatusNotFound, "Group not found")
}

func TestGroupMembersList(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	g := f.groupIn("Juniors", 100)
	a := f.student("A", g)
	b := f.student("B", g)
	c := f.student("C", g)
	d := f.student("D", g)
	f.exec("UPDATE students SET active = 0, cooldown_until = '2030-02-01 00:00:00' WHERE id = ?", d)
	gone := f.student("Gone", g)
	f.exec("UPDATE students SET deleted_at = datetime('now') WHERE id = ?", gone)
	f.buddies(a, b)

	// C's buddies are in another group and in none: never invited together with C.
	away := f.student("Away", f.group("Seniors"))
	loose := f.insert("INSERT INTO students (first_name, last_name, email) VALUES ('Loose', 'X', 'loose@example.com') RETURNING id")
	f.buddies(c, away, loose)
	f.invitation(f.sessionID, b, f.timeslots[0], f.slots[0], g, "invited")

	members := f.admin(http.MethodGet, groupPath(g, "members"), nil).status(http.StatusOK).array()
	var order []string
	for _, m := range members {
		order = append(order, m["first_name"].(string))
	}
	if got := strings.Join(order, ","); got != "A,B,C,D" {
		t.Fatalf("members = %s, want by name, inactive included and deleted left out", got)
	}

	byName := map[string]map[string]any{}
	for _, m := range members {
		byName[m["first_name"].(string)] = m
	}

	bg, _ := byName["A"]["buddy_group"].(map[string]any)
	if bg == nil || bg["name"] != "A & B" || bg["buddies"] != nil || len(bg["elsewhere"].([]any)) != 0 {
		t.Errorf("A buddy_group = %v, want A & B with nobody elsewhere", byName["A"]["buddy_group"])
	}

	elsewhere := map[string]any{}
	for _, raw := range byName["C"]["buddy_group"].(map[string]any)["elsewhere"].([]any) {
		b := raw.(map[string]any)
		elsewhere[b["first_name"].(string)] = b["group_name"]
	}

	if fmt.Sprint(elsewhere) != "map[Away:Seniors Loose:<nil>]" {
		t.Errorf("C's buddies elsewhere = %v, want Away in Seniors and Loose in no group", elsewhere)
	}

	if m := byName["D"]; m["active"] != 0.0 || m["cooldown_until"] != "2030-02-01 00:00:00" {
		t.Errorf("D = %v, want inactive with its cooldown", m)
	}

	// Membership only: the queue and invitations are shown per timetable and session.
	keys := slices.Sorted(maps.Keys(byName["A"]))
	if want := []string{"active", "buddy_group", "cooldown_until", "first_name", "id", "last_name"}; !slices.Equal(keys, want) {
		t.Errorf("member fields = %v, want %v", keys, want)
	}

	f.admin(http.MethodGet, groupPath(999, "members"), nil).wantError(http.StatusNotFound, "Group not found")
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
	g := e.insert("INSERT INTO groups (name) VALUES ('Bare') RETURNING id")
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

func TestGroupRoutesRejectBadInput(t *testing.T) {
	e := newTestEnv(t)
	g := e.group("Group")
	d := e.discipline("Discipline", g)
	st := e.student("Student", g)
	p := fmt.Sprintf
	e.wantRejected(
		notFound("PUT", "/api/groups/x", map[string]any{}, "Group not found"),
		notFound("DELETE", "/api/groups/x", nil, "Group not found"),
		notFound("POST", "/api/groups/x/set-default", nil, "Group not found"),
		notFound("POST", "/api/groups/999999/set-default", nil, "Group not found"), // inside the transaction
		notFound("POST", "/api/groups/x/unset-default", nil, "Group not found"),
		notFound("GET", "/api/groups/x/members", nil, "Group not found"),
		notFound("POST", "/api/groups/x/members", map[string]any{"student_id": st}, "Group not found"),
		notFound("DELETE", p("/api/groups/x/members/%d", st), nil, "Group not found"),
		notFound("DELETE", p("/api/groups/%d/members/x", g), nil, "Member not found"),
		notFound("GET", "/api/groups/x/non-members", nil, "Group not found"),
		notFound("GET", "/api/groups/x/disciplines", nil, "Group not found"),
		notFound("POST", p("/api/groups/x/disciplines/%d", d), nil, "Group not found"),
		notFound("POST", p("/api/groups/%d/disciplines/x", g), nil, "Discipline not found"),
		notFound("DELETE", p("/api/groups/x/disciplines/%d", d), nil, "Group not found"),
		notFound("DELETE", p("/api/groups/%d/disciplines/x", g), nil, "Discipline not found"),
		badJSON("POST", "/api/groups"),
		badJSON("PUT", p("/api/groups/%d", g)),
		badJSON("POST", p("/api/groups/%d/members", g)),
	)
	if e.row("SELECT is_default FROM groups WHERE id = ?", g)["is_default"] != int64(0) {
		t.Fatal("rejected set-default changed the default group")
	}
}
