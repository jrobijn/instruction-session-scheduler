package server

import (
	"net/http"
	"strconv"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

type Instructor struct {
	ID        int64  `db:"id" json:"id"`
	FirstName string `db:"first_name" json:"first_name"`
	LastName  string `db:"last_name" json:"last_name"`
	Email     string `db:"email" json:"email"`
	Active    int64  `db:"active" json:"active"`
}

func (s *Server) listInstructors() ([]Instructor, error) {
	return db.Many[Instructor](s.db, `
		SELECT id, first_name, last_name, email, active FROM instructors
		WHERE deleted_at IS NULL
		ORDER BY last_name ASC, first_name ASC`)
}

// getInstructor loads a (non-deleted) instructor; found is false if there is none.
func (s *Server) getInstructor(id int64) (Instructor, bool, error) {
	return db.One[Instructor](s.db, `
		SELECT id, first_name, last_name, email, active FROM instructors
		WHERE id = ? AND deleted_at IS NULL`, id)
}

func (s *Server) instructorRoutes() {
	s.adminRoute("GET /api/instructors", func(w http.ResponseWriter, r *http.Request) error {
		instructors, err := s.listInstructors()
		if err != nil {
			return err
		}
		httpx.OK(w, instructors)
		return nil
	})

	s.adminRoute("GET /api/instructors/export", func(w http.ResponseWriter, r *http.Request) error {
		instructors, err := s.listInstructors()
		if err != nil {
			return err
		}
		rows := make([][]string, len(instructors))
		for i, in := range instructors {
			rows[i] = []string{in.FirstName, in.LastName, in.Email, strconv.FormatInt(in.Active, 10)}
		}
		return writeCSV(w, "instructors.csv", []string{"first_name", "last_name", "email", "active"}, rows)
	})

	s.adminRoute("POST /api/instructors/import", func(w http.ResponseWriter, r *http.Request) error {
		in, err := readCSVImport(r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		if !in.has("first_name", "last_name", "email") {
			httpx.Error(w, http.StatusBadRequest, "CSV must contain first_name, last_name, and email columns")
			return nil
		}

		result := importResult{Errors: []string{}}
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			for _, row := range in.rows {
				first, last, email := row.get("first_name"), row.get("last_name"), row.get("email")
				if first == "" || last == "" || email == "" {
					result.skip(row, "missing required fields")
					continue
				}
				id, found, err := db.One[int64](tx, "SELECT id FROM instructors WHERE email = ? AND deleted_at IS NULL", email)
				if err != nil {
					return err
				}
				if found {
					_, err = tx.Exec("UPDATE instructors SET first_name = ?, last_name = ? WHERE id = ?", first, last, id)
				} else {
					_, err = tx.Exec("INSERT INTO instructors (first_name, last_name, email) VALUES (?, ?, ?)", first, last, email)
				}
				if isUniqueErr(err, "instructors.email") { // the email belongs to a deleted instructor
					result.skip(row, "An instructor with this email already exists")
					continue
				}
				if err != nil {
					return err
				}
				result.Imported++
			}
			return nil
		})
		if err != nil {
			return err
		}
		httpx.OK(w, result)
		return nil
	})

	s.adminRoute("GET /api/instructors/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Instructor not found")
			return nil
		}
		row, found, err := s.getInstructor(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Instructor not found")
			return nil
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/instructors", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			FirstName string `json:"first_name"`
			LastName  string `json:"last_name"`
			Email     string `json:"email"`
		}
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		if in.FirstName == "" || in.LastName == "" || in.Email == "" {
			httpx.Error(w, http.StatusBadRequest, "First name, last name and email are required")
			return nil
		}
		row, err := db.Get[Instructor](s.db, "INSERT INTO instructors (first_name, last_name, email) VALUES (?, ?, ?) RETURNING id, first_name, last_name, email, active",
			in.FirstName, in.LastName, in.Email)
		if isUniqueErr(err, "instructors.email") {
			httpx.Error(w, http.StatusConflict, "An instructor with this email already exists")
			return nil
		}
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/instructors/{id}", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			FirstName *string `json:"first_name"`
			LastName  *string `json:"last_name"`
			Email     *string `json:"email"`
			Active    *int64  `json:"active"`
		}
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Instructor not found")
			return nil
		}
		row, found, err := db.One[Instructor](s.db, `
			UPDATE instructors SET
				first_name = COALESCE(?, first_name),
				last_name = COALESCE(?, last_name),
				email = COALESCE(?, email),
				active = COALESCE(?, active)
			WHERE id = ? AND deleted_at IS NULL
			RETURNING id, first_name, last_name, email, active`,
			in.FirstName, in.LastName, in.Email, in.Active, id)
		if isUniqueErr(err, "instructors.email") {
			httpx.Error(w, http.StatusConflict, "An instructor with this email already exists")
			return nil
		}
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Instructor not found")
			return nil
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/instructors/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Instructor not found")
			return nil
		}
		if _, found, err := db.One[int](s.db, "SELECT 1 FROM instructors WHERE id = ? AND deleted_at IS NULL", id); err != nil {
			return err
		} else if !found {
			httpx.Error(w, http.StatusNotFound, "Instructor not found")
			return nil
		}
		// The instructor leaves every session that hasn't taken place, as if removed from each
		// one; completed sessions are history and stay as they are.
		type openSlot struct {
			SessionID int64 `db:"session_id"`
			SlotID    int64 `db:"slot_id"`
		}
		slots, err := db.Many[openSlot](s.db, `
			SELECT ss.session_id, ss.id AS slot_id FROM session_slots ss
			JOIN training_sessions ts ON ts.id = ss.session_id
			WHERE ss.instructor_id = ? AND ss.removed = 0 AND ts.status != 'completed'`, id)
		if err != nil {
			return err
		}
		for _, slot := range slots {
			if _, err := s.removeSlot(slot.SessionID, slot.SlotID); err != nil {
				return err
			}
		}
		// Soft-delete: mark as deleted and deactivate.
		if _, err := s.db.Exec("UPDATE instructors SET deleted_at = datetime('now'), active = 0 WHERE id = ?", id); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})
}
