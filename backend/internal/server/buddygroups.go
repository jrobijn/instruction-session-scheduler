package server

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

func (s *Server) buddyGroupRoutes() {
	s.adminRoute("POST /api/buddy-groups/quick-create", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		ids, isArray := b["student_ids"].([]any)
		if !isArray || len(ids) < 2 {
			httpx.Error(w, http.StatusBadRequest, "At least 2 students are required")
			return nil
		}

		var first, last string
		err := s.db.QueryRow(
			"SELECT s.first_name, s.last_name FROM buddy_group_members bgm JOIN students s ON s.id = bgm.student_id WHERE bgm.student_id IN ("+placeholders(len(ids))+")",
			args(ids)...).Scan(&first, &last)
		if err == nil {
			httpx.Error(w, http.StatusBadRequest, first+" "+last+" is already in a buddy group")
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		// Unlike the TS version, the inserts are atomic: a bad student id leaves no half-made group.
		var groupID int64
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			res, err := tx.Exec("INSERT INTO buddy_groups DEFAULT VALUES")
			if err != nil {
				return err
			}
			groupID = lastID(res)
			for _, sid := range ids {
				if _, err := tx.Exec("INSERT INTO buddy_group_members (buddy_group_id, student_id) VALUES (?, ?)", groupID, arg(sid)); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, map[string]int64{"id": groupID})
		return nil
	})

	s.adminRoute("DELETE /api/buddy-groups/{id}", func(w http.ResponseWriter, r *http.Request) error {
		res, err := s.db.Exec("DELETE FROM buddy_groups WHERE id = ?", r.PathValue("id"))
		if err != nil {
			return err
		}
		if changes(res) == 0 {
			httpx.Error(w, http.StatusNotFound, "Buddy group not found")
			return nil
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/buddy-groups/{id}/members/{studentId}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM buddy_groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Buddy group not found")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM buddy_group_members WHERE buddy_group_id = ? AND student_id = ?", id, r.PathValue("studentId")); err != nil {
			return err
		}
		// Delete the group if no members remain.
		if !s.exists("SELECT 1 FROM buddy_group_members WHERE buddy_group_id = ?", id) {
			if _, err := s.db.Exec("DELETE FROM buddy_groups WHERE id = ?", id); err != nil {
				return err
			}
		}
		httpx.Success(w)
		return nil
	})
}

// exists reports whether query returns at least one row.
func (s *Server) exists(query string, a ...any) bool {
	var one any
	return s.db.QueryRow(query, a...).Scan(&one) == nil
}
