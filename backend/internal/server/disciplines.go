package server

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

type Discipline struct {
	ID           int64  `db:"id" json:"id"`
	Name         string `db:"name" json:"name"`
	Abbreviation string `db:"abbreviation" json:"abbreviation"`
	Active       int64  `db:"active" json:"active"`
}

func (s *Server) listDisciplines() ([]Discipline, error) {
	return db.Many[Discipline](s.db, "SELECT id, name, abbreviation, active FROM disciplines ORDER BY name ASC")
}

func (s *Server) getDiscipline(id any) (Discipline, bool, error) {
	return db.One[Discipline](s.db, "SELECT id, name, abbreviation, active FROM disciplines WHERE id = ?", id)
}

type DisciplineWithGroups struct {
	Discipline
	Groups []GroupRef `json:"groups"`
}

// DisciplineOption is a discipline as offered to an invited student.
type DisciplineOption struct {
	ID   int64  `db:"id" json:"id"`
	Name string `db:"name" json:"name"`
}

func (s *Server) disciplineRoutes() {
	s.adminRoute("GET /api/disciplines", func(w http.ResponseWriter, r *http.Request) error {
		disciplines, err := s.listDisciplines()
		if err != nil {
			return err
		}
		type link struct {
			DisciplineID int64 `db:"discipline_id"`
			GroupRef
		}
		links, err := db.Many[link](s.db, `
			SELECT dg.discipline_id, g.id, g.name
			FROM discipline_groups dg
			JOIN groups g ON g.id = dg.group_id
			ORDER BY g.name ASC`)
		if err != nil {
			return err
		}
		byDiscipline := map[int64][]GroupRef{}
		for _, l := range links {
			byDiscipline[l.DisciplineID] = append(byDiscipline[l.DisciplineID], l.GroupRef)
		}
		out := make([]DisciplineWithGroups, len(disciplines))
		for i, d := range disciplines {
			groups := byDiscipline[d.ID]
			if groups == nil {
				groups = []GroupRef{}
			}
			out[i] = DisciplineWithGroups{Discipline: d, Groups: groups}
		}
		httpx.OK(w, out)
		return nil
	})

	s.adminRoute("GET /api/disciplines/export", func(w http.ResponseWriter, r *http.Request) error {
		disciplines, err := s.listDisciplines()
		if err != nil {
			return err
		}
		lines := make([]string, len(disciplines))
		for i, d := range disciplines {
			lines[i] = csvRow(d.Name, d.Abbreviation, strconv.FormatInt(d.Active, 10))
		}
		writeCSV(w, "disciplines.csv", "name,abbreviation,active", lines)
		return nil
	})

	s.adminRoute("POST /api/disciplines/import", func(w http.ResponseWriter, r *http.Request) error {
		lines, ok := readCSVImport(w, r)
		if !ok {
			return nil
		}
		header := csvHeader(lines[0])
		nameIdx, abbrIdx := indexOf(header, "name"), indexOf(header, "abbreviation")
		if nameIdx == -1 {
			httpx.Error(w, http.StatusBadRequest, "CSV must contain a name column")
			return nil
		}

		result := importResult{Errors: []string{}}
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			for i := 1; i < len(lines); i++ {
				fields := parseCSVLine(lines[i])
				name, abbr := field(fields, nameIdx), field(fields, abbrIdx)
				if name == "" {
					result.Errors = append(result.Errors, fmt.Sprintf("Row %d: missing name", i+1))
					result.Skipped++
					continue
				}
				var id int64
				var err error
				existing := false
				switch scanErr := tx.QueryRow("SELECT id FROM disciplines WHERE name = ?", name).Scan(&id); scanErr {
				case nil:
					existing = true
					_, err = tx.Exec("UPDATE disciplines SET abbreviation = ? WHERE id = ?", abbr, id)
				case sql.ErrNoRows:
					_, err = tx.Exec("INSERT INTO disciplines (name, abbreviation) VALUES (?, ?)", name, abbr)
				default:
					err = scanErr
				}
				switch {
				case isUniqueErr(err):
					result.Errors = append(result.Errors, fmt.Sprintf("Row %d: A discipline with this name already exists", i+1))
					result.Skipped++
				case err != nil:
					return err
				case existing: // updating an existing discipline counts as skipped in the TS version
					result.Skipped++
				default:
					result.Imported++
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		httpx.OK(w, result)
		return nil
	})

	s.adminRoute("GET /api/disciplines/{id}", func(w http.ResponseWriter, r *http.Request) error {
		row, found, err := s.getDiscipline(r.PathValue("id"))
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/disciplines", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Name         string `json:"name"`
			Abbreviation string `json:"abbreviation"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.Name == "" {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}
		res, err := s.db.Exec("INSERT INTO disciplines (name, abbreviation) VALUES (?, ?)", in.Name, in.Abbreviation)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A discipline with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, _, err := s.getDiscipline(lastID(res))
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/disciplines/{id}", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Name         *string `json:"name"`
			Abbreviation *string `json:"abbreviation"`
			Active       *int64  `json:"active"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM disciplines WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		_, err := s.db.Exec(`
			UPDATE disciplines SET
				name = COALESCE(?, name),
				abbreviation = COALESCE(?, abbreviation),
				active = COALESCE(?, active)
			WHERE id = ?`,
			in.Name, in.Abbreviation, in.Active, id)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A discipline with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, _, err := s.getDiscipline(id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("PUT /api/disciplines/{id}/groups", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			GroupIDs []int64 `json:"group_ids"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.GroupIDs == nil {
			httpx.Error(w, http.StatusBadRequest, "group_ids array is required")
			return nil
		}
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM disciplines WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			if _, err := tx.Exec("DELETE FROM discipline_groups WHERE discipline_id = ?", id); err != nil {
				return err
			}
			for _, gid := range in.GroupIDs {
				if _, err := tx.Exec("INSERT INTO discipline_groups (discipline_id, group_id) VALUES (?, ?)", id, gid); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("GET /api/disciplines/{id}/groups", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM disciplines WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		groups, err := db.Many[GroupSummary](s.db, `
			SELECT g.id, g.name, g.is_default, g.active
			FROM groups g
			JOIN discipline_groups dg ON dg.group_id = g.id
			WHERE dg.discipline_id = ?
			ORDER BY g.name ASC`, id)
		if err != nil {
			return err
		}
		httpx.OK(w, groups)
		return nil
	})

	s.adminRoute("POST /api/disciplines/{id}/groups/{groupId}", func(w http.ResponseWriter, r *http.Request) error {
		id, groupID := r.PathValue("id"), r.PathValue("groupId")
		if !s.exists("SELECT 1 FROM disciplines WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", groupID) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if _, err := s.db.Exec("INSERT OR IGNORE INTO discipline_groups (discipline_id, group_id) VALUES (?, ?)", id, groupID); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/disciplines/{id}/groups/{groupId}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM disciplines WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM discipline_groups WHERE discipline_id = ? AND group_id = ?", id, r.PathValue("groupId")); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/disciplines/{id}", func(w http.ResponseWriter, r *http.Request) error {
		res, err := s.db.Exec("DELETE FROM disciplines WHERE id = ?", r.PathValue("id"))
		if err != nil {
			return err
		}
		if changes(res) == 0 {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		httpx.Success(w)
		return nil
	})
}

const activeDisciplinesSQL = "SELECT id, name FROM disciplines WHERE active = 1 ORDER BY name ASC"

func (s *Server) handlePublicDisciplines(w http.ResponseWriter, _ *http.Request) {
	disciplines, err := db.Many[DisciplineOption](s.db, activeDisciplinesSQL)
	if err != nil {
		s.internalError(w, err)
		return
	}
	httpx.OK(w, disciplines)
}

// handlePublicDisciplinesForToken returns the disciplines available to the invited student.
func (s *Server) handlePublicDisciplinesForToken(w http.ResponseWriter, r *http.Request) {
	type tokenInvitation struct {
		StudentID int64  `db:"student_id"`
		GroupID   *int64 `db:"group_id"`
	}
	inv, found, err := db.One[tokenInvitation](s.db, "SELECT student_id, group_id FROM invitations WHERE token = ?", r.PathValue("token"))
	if err != nil {
		s.internalError(w, err)
		return
	}

	var disciplines []DisciplineOption
	switch {
	case !found:
		disciplines, err = db.Many[DisciplineOption](s.db, activeDisciplinesSQL)
	case inv.GroupID != nil:
		// Auto-scheduled: disciplines linked to the invitation's specific group.
		disciplines, err = db.Many[DisciplineOption](s.db, `
			SELECT DISTINCT d.id, d.name FROM disciplines d
			JOIN discipline_groups dg ON dg.discipline_id = d.id
			WHERE d.active = 1 AND dg.group_id = ?
			ORDER BY d.name ASC`, *inv.GroupID)
	default:
		// Manually assigned (no group): disciplines from all the student's groups.
		disciplines, err = db.Many[DisciplineOption](s.db, `
			SELECT DISTINCT d.id, d.name FROM disciplines d
			JOIN discipline_groups dg ON dg.discipline_id = d.id
			JOIN student_groups sg ON sg.group_id = dg.group_id
			WHERE d.active = 1 AND sg.student_id = ?
			ORDER BY d.name ASC`, inv.StudentID)
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	httpx.OK(w, disciplines)
}
