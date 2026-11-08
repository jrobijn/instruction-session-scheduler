package server

import (
	"database/sql"
	"fmt"
	"net/http"

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
func (s *Server) getInstructor(id any) (Instructor, bool, error) {
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
		lines := make([]string, len(instructors))
		for i, in := range instructors {
			lines[i] = csvRow(in.FirstName, in.LastName, in.Email, in.Active)
		}
		writeCSV(w, "instructors.csv", "first_name,last_name,email,active", lines)
		return nil
	})

	s.adminRoute("POST /api/instructors/import", func(w http.ResponseWriter, r *http.Request) error {
		lines, ok := readCSVImport(w, r)
		if !ok {
			return nil
		}
		header := csvHeader(lines[0])
		firstIdx, lastIdx, emailIdx := indexOf(header, "first_name"), indexOf(header, "last_name"), indexOf(header, "email")
		if firstIdx == -1 || lastIdx == -1 || emailIdx == -1 {
			httpx.Error(w, http.StatusBadRequest, "CSV must contain first_name, last_name, and email columns")
			return nil
		}

		result := importResult{Errors: []string{}}
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			for i := 1; i < len(lines); i++ {
				fields := parseCSVLine(lines[i])
				first, last, email := field(fields, firstIdx), field(fields, lastIdx), field(fields, emailIdx)
				if first == "" || last == "" || email == "" {
					result.Errors = append(result.Errors, fmt.Sprintf("Row %d: missing required fields", i+1))
					result.Skipped++
					continue
				}
				var id int64
				var err error
				switch scanErr := tx.QueryRow("SELECT id FROM instructors WHERE email = ? AND deleted_at IS NULL", email).Scan(&id); scanErr {
				case nil:
					_, err = tx.Exec("UPDATE instructors SET first_name = ?, last_name = ? WHERE id = ?", first, last, id)
				case sql.ErrNoRows:
					_, err = tx.Exec("INSERT INTO instructors (first_name, last_name, email) VALUES (?, ?, ?)", first, last, email)
				default:
					err = scanErr
				}
				if err != nil {
					result.Errors = append(result.Errors, fmt.Sprintf("Row %d: %s", i+1, sqliteMessage(err)))
					result.Skipped++
					continue
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
		row, found, err := s.getInstructor(r.PathValue("id"))
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
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.FirstName == "" || in.LastName == "" || in.Email == "" {
			httpx.Error(w, http.StatusBadRequest, "First name, last name and email are required")
			return nil
		}
		res, err := s.db.Exec("INSERT INTO instructors (first_name, last_name, email) VALUES (?, ?, ?)",
			in.FirstName, in.LastName, in.Email)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "An instructor with this email already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, _, err := s.getInstructor(lastID(res))
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
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM instructors WHERE id = ? AND deleted_at IS NULL", id) {
			httpx.Error(w, http.StatusNotFound, "Instructor not found")
			return nil
		}
		_, err := s.db.Exec(`
			UPDATE instructors SET
				first_name = COALESCE(?, first_name),
				last_name = COALESCE(?, last_name),
				email = COALESCE(?, email),
				active = COALESCE(?, active)
			WHERE id = ?`,
			in.FirstName, in.LastName, in.Email, in.Active, id)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "An instructor with this email already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, _, err := s.getInstructor(id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/instructors/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM instructors WHERE id = ? AND deleted_at IS NULL", id) {
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
