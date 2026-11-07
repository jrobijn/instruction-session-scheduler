package server

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

func (s *Server) disciplineRoutes() {
	s.adminRoute("GET /api/disciplines", func(w http.ResponseWriter, r *http.Request) error {
		disciplines, err := db.All(s.db, "SELECT * FROM disciplines ORDER BY name ASC")
		if err != nil {
			return err
		}
		links, err := db.All(s.db, `
			SELECT dg.discipline_id, dg.group_id, g.name AS group_name
			FROM discipline_groups dg
			JOIN groups g ON g.id = dg.group_id
			ORDER BY g.name ASC`)
		if err != nil {
			return err
		}
		byDiscipline := map[int64][]map[string]any{}
		for _, l := range links {
			id := toInt64(l["discipline_id"])
			byDiscipline[id] = append(byDiscipline[id], map[string]any{"id": l["group_id"], "name": l["group_name"]})
		}
		for _, d := range disciplines {
			groups := byDiscipline[toInt64(d["id"])]
			if groups == nil {
				groups = []map[string]any{}
			}
			d["groups"] = groups
		}
		httpx.OK(w, disciplines)
		return nil
	})

	s.adminRoute("GET /api/disciplines/export", func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.All(s.db, "SELECT name, abbreviation, active FROM disciplines ORDER BY name ASC")
		if err != nil {
			return err
		}
		lines := make([]string, len(rows))
		for i, row := range rows {
			lines[i] = csvRow(row["name"], row["abbreviation"], row["active"])
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
		err := s.db.InTx(func(tx *sql.Tx) error {
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
				case err != nil:
					result.Errors = append(result.Errors, fmt.Sprintf("Row %d: %s", i+1, sqliteMessage(err)))
					result.Skipped++
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
		row, err := db.Get(s.db, "SELECT * FROM disciplines WHERE id = ?", r.PathValue("id"))
		if err != nil {
			return err
		}
		if row == nil {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/disciplines", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		if !truthy(b["name"]) {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}
		abbr := any("")
		if truthy(b["abbreviation"]) {
			abbr = arg(b["abbreviation"])
		}
		res, err := s.db.Exec("INSERT INTO disciplines (name, abbreviation) VALUES (?, ?)", arg(b["name"]), abbr)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A discipline with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM disciplines WHERE id = ?", lastID(res))
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/disciplines/{id}", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
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
			arg(b["name"]), arg(b["abbreviation"]), arg(b["active"]), id)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A discipline with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM disciplines WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("PUT /api/disciplines/{id}/groups", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		groupIDs, isArray := b["group_ids"].([]any)
		if !isArray {
			httpx.Error(w, http.StatusBadRequest, "group_ids array is required")
			return nil
		}
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM disciplines WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		err := s.db.InTx(func(tx *sql.Tx) error {
			if _, err := tx.Exec("DELETE FROM discipline_groups WHERE discipline_id = ?", id); err != nil {
				return err
			}
			for _, gid := range groupIDs {
				if _, err := tx.Exec("INSERT INTO discipline_groups (discipline_id, group_id) VALUES (?, ?)", id, arg(gid)); err != nil {
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
		rows, err := db.All(s.db, `
			SELECT g.id, g.name, g.is_default, g.active
			FROM groups g
			JOIN discipline_groups dg ON dg.group_id = g.id
			WHERE dg.discipline_id = ?
			ORDER BY g.name ASC`, id)
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
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
