package server

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestDisciplineCRUD(t *testing.T) {
	e := newTestEnv(t)
	g := e.insert("INSERT INTO groups (name) VALUES ('G') RETURNING id")
	h := e.insert("INSERT INTO groups (name) VALUES ('H') RETURNING id")

	e.admin(http.MethodPost, "/api/disciplines", map[string]any{}).wantError(http.StatusBadRequest, "Name is required")
	d := toInt64(e.admin(http.MethodPost, "/api/disciplines", map[string]any{"name": "Kayak", "abbreviation": "K"}).status(http.StatusCreated).object()["id"])
	e.admin(http.MethodPost, "/api/disciplines", map[string]any{"name": "Kayak"}).wantError(http.StatusConflict, "A discipline with this name already exists")
	other := toInt64(e.admin(http.MethodPost, "/api/disciplines", map[string]any{"name": "Canoe"}).status(http.StatusCreated).object()["id"])
	path := fmt.Sprintf("/api/disciplines/%d", d)

	got := e.admin(http.MethodPut, path, map[string]any{"active": 0}).status(http.StatusOK).object()
	if got["active"] != 0.0 || got["name"] != "Kayak" || got["abbreviation"] != "K" {
		t.Fatalf("updated = %v", got)
	}
	e.admin(http.MethodPut, path, map[string]any{"name": "Canoe"}).wantError(http.StatusConflict, "A discipline with this name already exists")
	e.admin(http.MethodPut, "/api/disciplines/999", map[string]any{}).wantError(http.StatusNotFound, "Discipline not found")

	e.admin(http.MethodPut, path+"/groups", map[string]any{}).wantError(http.StatusBadRequest, "group_ids array is required")
	e.admin(http.MethodPut, path+"/groups", map[string]any{"group_ids": []any{g, h}}).status(http.StatusOK)
	e.admin(http.MethodDelete, fmt.Sprintf("%s/groups/%d", path, h), nil).status(http.StatusOK)
	e.admin(http.MethodPost, fmt.Sprintf("/api/disciplines/%d/groups/%d", other, g), nil).status(http.StatusOK)
	e.admin(http.MethodPost, fmt.Sprintf("/api/disciplines/%d/groups/%d", other, g), nil).status(http.StatusOK) // idempotent
	e.admin(http.MethodPost, fmt.Sprintf("/api/disciplines/%d/groups/999", other), nil).wantError(http.StatusNotFound, "Group not found")

	if got := e.admin(http.MethodGet, path+"/groups", nil).status(http.StatusOK).array(); len(got) != 1 || got[0]["name"] != "G" {
		t.Fatalf("discipline groups = %v", got)
	}
	list := e.admin(http.MethodGet, "/api/disciplines", nil).status(http.StatusOK).array()
	if len(list) != 2 || list[0]["name"] != "Canoe" || len(list[1]["groups"].([]any)) != 1 {
		t.Fatalf("disciplines = %v", list)
	}

	e.admin(http.MethodDelete, path, nil).status(http.StatusOK)
	e.admin(http.MethodGet, path, nil).wantError(http.StatusNotFound, "Discipline not found")
	e.admin(http.MethodDelete, path, nil).wantError(http.StatusNotFound, "Discipline not found")
	for _, p := range []string{path + "/groups"} {
		e.admin(http.MethodGet, p, nil).wantError(http.StatusNotFound, "Discipline not found")
	}
}

func TestDisciplineImportExport(t *testing.T) {
	e := newTestEnv(t)
	e.discipline("Kayak")
	csv := "name,abbreviation\nKayak,KY\nCanoe,C\n,X"
	res := e.admin(http.MethodPost, "/api/disciplines/import", map[string]any{"csv": csv}).status(http.StatusOK).object()
	// Updating an existing discipline counts as imported.
	if res["imported"] != 2.0 || res["skipped"] != 1.0 {
		t.Fatalf("import = %v", res)
	}
	body := string(e.admin(http.MethodGet, "/api/disciplines/export", nil).status(http.StatusOK).Body)
	if want := "name,abbreviation,active\nCanoe,C,1\nKayak,KY,1\n"; body != want {
		t.Fatalf("export = %q", body)
	}
}

func TestDisciplineRoutesRejectBadInput(t *testing.T) {
	e := newTestEnv(t)
	g := e.group("Group")
	d := e.discipline("Discipline", g)
	p := fmt.Sprintf
	e.wantRejected(
		notFound("GET", "/api/disciplines/x", nil, "Discipline not found"),
		notFound("PUT", "/api/disciplines/x", nil, "Discipline not found"),
		notFound("PUT", "/api/disciplines/x/groups", map[string]any{"group_ids": []int{}}, "Discipline not found"),
		notFound("GET", "/api/disciplines/x/groups", nil, "Discipline not found"),
		notFound("POST", p("/api/disciplines/x/groups/%d", g), nil, "Discipline not found"),
		notFound("POST", p("/api/disciplines/%d/groups/x", d), nil, "Group not found"),
		notFound("DELETE", p("/api/disciplines/x/groups/%d", g), nil, "Discipline not found"),
		notFound("DELETE", p("/api/disciplines/%d/groups/x", d), nil, "Group not found"),
		notFound("DELETE", "/api/disciplines/x", nil, "Discipline not found"),
		badJSON("POST", "/api/disciplines/import"),
		badJSON("POST", "/api/disciplines"),
		badJSON("PUT", p("/api/disciplines/%d", d)),
		badJSON("PUT", p("/api/disciplines/%d/groups", d)),
	)
}

func TestPublicDisciplines(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	juniors := f.groupIn("Juniors", 100) // with discipline "Juniors discipline"
	seniors := f.group("Seniors")
	inactive := f.discipline("Archived", juniors)
	f.exec("UPDATE disciplines SET active = 0 WHERE id = ?", inactive)
	a := f.student("A", juniors)
	manual := f.student("M", seniors)
	f.sendInvitations()
	f.invitation(f.sessionID, manual, f.timeslots[0], f.slots[0], 0, "invited")
	// A moves to Seniors after being invited; the invitation keeps its scheduled group.
	f.exec("UPDATE student_groups SET group_id = ? WHERE student_id = ?", seniors, a)
	// A manual invitation for a student who has since left every group.
	loner := f.student("L", seniors)
	f.exec("DELETE FROM student_groups WHERE student_id = ?", loner)
	f.invitation(f.sessionID, loner, f.timeslots[0], f.slots[0], 0, "invited")

	names := func(path string) string {
		var out []string
		for _, d := range f.public(http.MethodGet, path, nil).status(http.StatusOK).array() {
			out = append(out, d["name"].(string))
		}
		return strings.Join(out, ",")
	}
	if got := names("/api/public/disciplines"); got != "Juniors discipline,Seniors discipline" {
		t.Errorf("all active = %s", got)
	}
	if got := names("/api/public/disciplines/" + f.tokenOf("A")); got != "Juniors discipline" {
		t.Errorf("for auto-scheduled invitation = %s, want the invitation group's (active only)", got)
	}
	if got := names("/api/public/disciplines/" + f.tokenOf("M")); got != "Seniors discipline" {
		t.Errorf("for manual invitation = %s, want the student's group's", got)
	}
	// Exactly [] (not null): the invitation page maps over the result.
	if got := strings.TrimSpace(string(f.public(http.MethodGet, "/api/public/disciplines/"+f.tokenOf("L"), nil).status(http.StatusOK).Body)); got != "[]" {
		t.Errorf("for manual invitation of a student without a group = %s, want []", got)
	}
	f.public(http.MethodGet, "/api/public/disciplines/unknown", nil).wantError(http.StatusNotFound, "Invitation not found")
}
