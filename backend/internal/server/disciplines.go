package server

import (
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

// getDiscipline loads the discipline with the given id, reporting whether there is one.
func (s *Server) getDiscipline(id int64) (Discipline, bool, error) {
	return db.One[Discipline](s.db, "SELECT id, name, abbreviation, active FROM disciplines WHERE id = ?", id)
}

// getDisciplines lists all disciplines by name.
func (s *Server) getDisciplines() ([]Discipline, error) {
	return db.Many[Discipline](s.db, "SELECT id, name, abbreviation, active FROM disciplines ORDER BY name ASC")
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
		disciplines, err := s.getDisciplines()
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
		disciplines, err := s.getDisciplines()
		if err != nil {
			return err
		}

		rows := make([][]string, len(disciplines))
		for i, d := range disciplines {
			rows[i] = []string{d.Name, d.Abbreviation, strconv.FormatInt(d.Active, 10)}
		}

		return writeCSV(w, "disciplines.csv", []string{"name", "abbreviation", "active"}, rows)
	})

	s.adminRoute("POST /api/disciplines/import", func(w http.ResponseWriter, r *http.Request) error {
		in, err := readCSVImport(r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		if !in.has("name") {
			httpx.Error(w, http.StatusBadRequest, "CSV must contain a name column")
			return nil
		}

		result := importResult{Errors: []string{}}
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			for _, row := range in.rows {
				name, abbr := row.get("name"), row.get("abbreviation")
				if name == "" {
					result.skip(row, "missing name")
					continue
				}

				id, found, err := db.One[int64](tx, "SELECT id FROM disciplines WHERE name = ?", name)
				if err != nil {
					return err
				}
				if found {
					_, err = tx.Exec("UPDATE disciplines SET abbreviation = ? WHERE id = ?", abbr, id)
				} else {
					_, err = tx.Exec("INSERT INTO disciplines (name, abbreviation) VALUES (?, ?)", name, abbr)
				}

				switch {
				case isUniqueErr(err, "disciplines.name"):
					result.skip(row, "A discipline with this name already exists")
				case err != nil:
					return err
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
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		row, found, err := s.getDiscipline(id)
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

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		if in.Name == "" {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}

		row, err := db.Get[Discipline](s.db, "INSERT INTO disciplines (name, abbreviation) VALUES (?, ?) RETURNING id, name, abbreviation, active",
			in.Name, in.Abbreviation)
		if isUniqueErr(err, "disciplines.name") {
			httpx.Error(w, http.StatusConflict, "A discipline with this name already exists")
			return nil
		}
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

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		row, found, err := db.One[Discipline](s.db, `
			UPDATE disciplines SET
				name = COALESCE(?, name),
				abbreviation = COALESCE(?, abbreviation),
				active = COALESCE(?, active)
			WHERE id = ?
			RETURNING id, name, abbreviation, active`,
			in.Name, in.Abbreviation, in.Active, id)
		if isUniqueErr(err, "disciplines.name") {
			httpx.Error(w, http.StatusConflict, "A discipline with this name already exists")
			return nil
		}
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

	s.adminRoute("PUT /api/disciplines/{id}/groups", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			GroupIDs []int64 `json:"group_ids"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		if in.GroupIDs == nil {
			httpx.Error(w, http.StatusBadRequest, "group_ids array is required")
			return nil
		}

		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM disciplines WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		err = s.db.InTx(func(tx *sqlx.Tx) error {
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
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM disciplines WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		type groupSummary struct {
			ID        int64  `db:"id" json:"id"`
			Name      string `db:"name" json:"name"`
			IsDefault int64  `db:"is_default" json:"is_default"`
			Active    int64  `db:"active" json:"active"`
		}

		groups, err := db.Many[groupSummary](s.db, `
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
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM disciplines WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		groupID, ok := pathID(r, "groupId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", groupID); err != nil {
			return err
		} else if !found {
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
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM disciplines WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		groupID, ok := pathID(r, "groupId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		if _, err := s.db.Exec("DELETE FROM discipline_groups WHERE discipline_id = ? AND group_id = ?", id, groupID); err != nil {
			return err
		}

		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/disciplines/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		res, err := s.db.Exec("DELETE FROM disciplines WHERE id = ?", id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		httpx.Success(w)
		return nil
	})

	s.publicRoute("GET /api/public/disciplines", func(w http.ResponseWriter, _ *http.Request) error {
		disciplines, err := db.Many[DisciplineOption](s.db, "SELECT id, name FROM disciplines WHERE active = 1 ORDER BY name ASC")
		if err != nil {
			return err
		}

		httpx.OK(w, disciplines)
		return nil
	})

	// Returns the disciplines available to the invited student.
	s.publicRoute("GET /api/public/disciplines/{token}", func(w http.ResponseWriter, r *http.Request) error {
		type tokenInvitation struct {
			StudentID int64  `db:"student_id"`
			GroupID   *int64 `db:"group_id"`
		}

		inv, found, err := db.One[tokenInvitation](s.db, "SELECT student_id, group_id FROM invitations WHERE token = ?", r.PathValue("token"))
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}

		// Auto-scheduled invitations use the group they were scheduled from;
		// manual ones (no group) fall back to the student's current group.
		disciplines, err := db.Many[DisciplineOption](s.db, `
			SELECT d.id, d.name FROM disciplines d
			JOIN discipline_groups dg ON dg.discipline_id = d.id
			WHERE d.active = 1
			  AND dg.group_id = COALESCE(?, (SELECT group_id FROM student_groups WHERE student_id = ?))
			ORDER BY d.name ASC`, inv.GroupID, inv.StudentID)
		if err != nil {
			return err
		}

		httpx.OK(w, disciplines)
		return nil
	})
}
