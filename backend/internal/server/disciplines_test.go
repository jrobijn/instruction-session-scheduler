package server

import (
	"fmt"
	"net/http"
	"testing"
)

func TestDisciplineCRUD(t *testing.T) {
	e := newTestEnv(t)
	g := e.exec("INSERT INTO groups (name) VALUES ('G')")
	h := e.exec("INSERT INTO groups (name) VALUES ('H')")

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
	// Updating an existing discipline counts as skipped.
	if res["imported"] != 1.0 || res["skipped"] != 2.0 {
		t.Fatalf("import = %v", res)
	}
	body := string(e.admin(http.MethodGet, "/api/disciplines/export", nil).status(http.StatusOK).Body)
	if want := "name,abbreviation,active\nCanoe,C,1\nKayak,KY,1"; body != want {
		t.Fatalf("export = %q", body)
	}
}
