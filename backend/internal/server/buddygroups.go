package server

import (
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
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		ids := in.StudentIDs
		if len(ids) < 2 {
			httpx.Error(w, http.StatusBadRequest, "At least 2 students are required")
			return nil
		}

		query, queryArgs, err := sqlx.In("SELECT s.first_name || ' ' || s.last_name FROM buddy_group_members bgm JOIN students s ON s.id = bgm.student_id WHERE bgm.student_id IN (?)", ids)
		if err != nil {
			return err
		}
		name, found, err := db.One[string](s.db, query, queryArgs...)
		if err != nil {
			return err
		}
		if found {
			httpx.Error(w, http.StatusBadRequest, name+" is already in a buddy group")
			return nil
		}

		var groupID int64
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			var err error
			if groupID, err = db.Get[int64](tx, "INSERT INTO buddy_groups DEFAULT VALUES RETURNING id"); err != nil {
				return err
			}
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
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Buddy group not found")
			return nil
		}
		res, err := s.db.Exec("DELETE FROM buddy_groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			httpx.Error(w, http.StatusNotFound, "Buddy group not found")
			return nil
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/buddy-groups/{id}/members/{studentId}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Buddy group not found")
			return nil
		}
		if _, found, err := db.One[int](s.db, "SELECT 1 FROM buddy_groups WHERE id = ?", id); err != nil {
			return err
		} else if !found {
			httpx.Error(w, http.StatusNotFound, "Buddy group not found")
			return nil
		}
		studentID, ok := pathID(r, "studentId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Student not found")
			return nil
		}
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			if _, err := tx.Exec("DELETE FROM buddy_group_members WHERE buddy_group_id = ? AND student_id = ?", id, studentID); err != nil {
				return err
			}
			// Delete the group if no members remain.
			_, err := tx.Exec("DELETE FROM buddy_groups WHERE id = ? AND NOT EXISTS (SELECT 1 FROM buddy_group_members WHERE buddy_group_id = ?)", id, id)
			return err
		})
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})
}

// loadBuddies loads everyone's buddies, in the order they were added to their buddy group.
func loadBuddies(q db.Querier) (scheduling.Buddies, error) {
	type membership struct {
		BuddyGroupID int64 `db:"buddy_group_id"`
		StudentID    int64 `db:"student_id"`
	}
	memberships, err := db.Many[membership](q, "SELECT buddy_group_id, student_id FROM buddy_group_members ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	members := map[int64][]int64{}
	for _, m := range memberships {
		members[m.BuddyGroupID] = append(members[m.BuddyGroupID], m.StudentID)
	}
	// Map order doesn't matter: a student is in at most one group, so each student's
	// buddies come from exactly one group, in that group's insertion order.
	buddies := scheduling.Buddies{}
	for _, group := range members {
		for _, student := range group {
			for _, other := range group {
				if other != student {
					buddies[student] = append(buddies[student], other)
				}
			}
		}
	}
	return buddies, nil
}
