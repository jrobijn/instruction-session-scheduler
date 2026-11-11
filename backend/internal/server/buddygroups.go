package server

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/scheduling"
)

func (s *Server) buddyGroupRoutes() {
	s.adminRoute("POST /api/buddy-groups/quick-create", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			StudentIDs []int64 `json:"student_ids"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		ids := in.StudentIDs
		if len(ids) < 2 {
			httpx.Error(w, http.StatusBadRequest, "At least 2 students are required")
			return nil
		}

		query, queryArgs, err := sqlx.In("SELECT s.first_name, s.last_name FROM buddy_group_members bgm JOIN students s ON s.id = bgm.student_id WHERE bgm.student_id IN (?)", ids)
		if err != nil {
			return err
		}
		var first, last string
		err = s.db.QueryRow(query, queryArgs...).Scan(&first, &last)
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
				if _, err := tx.Exec("INSERT INTO buddy_group_members (buddy_group_id, student_id) VALUES (?, ?)", groupID, sid); err != nil {
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

// loadBuddies loads everyone's buddies, in the order they were added to their buddy group.
func (s *Server) loadBuddies() (scheduling.Buddies, error) {
	type membership struct {
		BuddyGroupID int64 `db:"buddy_group_id"`
		StudentID    int64 `db:"student_id"`
	}
	memberships, err := db.Many[membership](s.db, "SELECT buddy_group_id, student_id FROM buddy_group_members ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	members := map[int64][]int64{}
	for _, m := range memberships {
		members[m.BuddyGroupID] = append(members[m.BuddyGroupID], m.StudentID)
	}
	buddies := scheduling.Buddies{}
	for _, m := range memberships {
		for _, other := range members[m.BuddyGroupID] {
			if other != m.StudentID {
				buddies[m.StudentID] = append(buddies[m.StudentID], other)
			}
		}
	}
	return buddies, nil
}

// exists reports whether query returns at least one row.
func (s *Server) exists(query string, a ...any) bool {
	var one any
	return s.db.QueryRow(query, a...).Scan(&one) == nil
}
