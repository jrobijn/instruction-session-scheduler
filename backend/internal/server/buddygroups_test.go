package server

import (
	"fmt"
	"net/http"
	"testing"
)

func TestBuddyGroups(t *testing.T) {
	e := newTestEnv(t)
	g := e.group("G")
	a, b, c := e.student("Ann", g), e.student("Bob", g), e.student("Cy", g)

	e.admin(http.MethodPost, "/api/buddy-groups/quick-create", map[string]any{"student_ids": []any{a}}).
		wantError(http.StatusBadRequest, "At least 2 students are required")
	id := toInt64(e.admin(http.MethodPost, "/api/buddy-groups/quick-create", map[string]any{"student_ids": []any{a, b}}).
		status(http.StatusCreated).object()["id"])
	e.admin(http.MethodPost, "/api/buddy-groups/quick-create", map[string]any{"student_ids": []any{c, b}}).
		wantError(http.StatusBadRequest, "Bob Test is already in a buddy group")

	// Removing members; the group goes away with its last member.
	e.admin(http.MethodDelete, fmt.Sprintf("/api/buddy-groups/%d/members/%d", id, a), nil).status(http.StatusOK)
	if e.row("SELECT 1 FROM buddy_groups WHERE id = ?", id) == nil {
		t.Fatal("group with a member left was deleted")
	}
	e.admin(http.MethodDelete, fmt.Sprintf("/api/buddy-groups/%d/members/%d", id, b), nil).status(http.StatusOK)
	if e.row("SELECT 1 FROM buddy_groups WHERE id = ?", id) != nil {
		t.Fatal("empty buddy group not deleted")
	}
	e.admin(http.MethodDelete, fmt.Sprintf("/api/buddy-groups/%d/members/%d", id, b), nil).wantError(http.StatusNotFound, "Buddy group not found")

	id = toInt64(e.admin(http.MethodPost, "/api/buddy-groups/quick-create", map[string]any{"student_ids": []any{a, c}}).
		status(http.StatusCreated).object()["id"])
	e.admin(http.MethodDelete, fmt.Sprintf("/api/buddy-groups/%d", id), nil).status(http.StatusOK)
	if n := len(e.rows("SELECT 1 FROM buddy_group_members")); n != 0 {
		t.Fatalf("%d members left", n)
	}
	e.admin(http.MethodDelete, fmt.Sprintf("/api/buddy-groups/%d", id), nil).wantError(http.StatusNotFound, "Buddy group not found")
}

func TestBuddyGroupCreateIsAtomic(t *testing.T) {
	e := newTestEnv(t)
	a := e.student("Ann", e.group("G"))
	e.admin(http.MethodPost, "/api/buddy-groups/quick-create", map[string]any{"student_ids": []any{a, 999}}).
		status(http.StatusInternalServerError)
	if n := len(e.rows("SELECT 1 FROM buddy_groups")); n != 0 {
		t.Fatal("a failed create left a buddy group behind")
	}
}
