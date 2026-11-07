package server

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

func (s *Server) timetableRoutes() {
	s.adminRoute("GET /api/timetables", func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.All(s.db, `
			SELECT t.*,
				(SELECT COUNT(*) FROM timeslots WHERE timetable_id = t.id) AS timeslot_count
			FROM timetables t
			ORDER BY t.created_at DESC`)
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
		return nil
	})

	s.adminRoute("GET /api/timetables/{id}", func(w http.ResponseWriter, r *http.Request) error {
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		id := r.PathValue("id")
		timeslots, err := db.All(s.db, "SELECT * FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC", id)
		if err != nil {
			return err
		}
		groups, err := db.All(s.db, `
			SELECT tg.group_id, tg.percentage, g.name AS group_name, g.is_default, g.color AS group_color
			FROM timetable_groups tg
			JOIN groups g ON g.id = tg.group_id
			WHERE tg.timetable_id = ?
			ORDER BY tg.position ASC`, id)
		if err != nil {
			return err
		}
		t["timeslots"] = timeslots
		t["groups"] = groups
		httpx.OK(w, t)
		return nil
	})

	s.adminRoute("POST /api/timetables", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		if !truthy(b["name"]) {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}
		res, err := s.db.Exec("INSERT INTO timetables (name) VALUES (?)", arg(b["name"]))
		if err != nil {
			return err
		}
		id := lastID(res)
		// Auto-assign the default group at 100%.
		var defaultGroup int64
		switch err := s.db.QueryRow("SELECT id FROM groups WHERE is_default = 1").Scan(&defaultGroup); err {
		case nil:
			if _, err := s.db.Exec("INSERT INTO timetable_groups (timetable_id, group_id, percentage, position) VALUES (?, ?, 100, 0)", id, defaultGroup); err != nil {
				return err
			}
		case sql.ErrNoRows:
		default:
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM timetables WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/timetables/{id}", func(w http.ResponseWriter, r *http.Request) error {
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		id := r.PathValue("id")
		if name, present := b["name"]; present {
			if t["status"] != "draft" {
				httpx.Error(w, http.StatusBadRequest, "Cannot edit a saved timetable")
				return nil
			}
			if _, err := s.db.Exec("UPDATE timetables SET name = ? WHERE id = ?", arg(name), id); err != nil {
				return err
			}
		}
		row, err := db.Get(s.db, "SELECT * FROM timetables WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/timetables/{id}/save", func(w http.ResponseWriter, r *http.Request) error {
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		id := r.PathValue("id")
		if t["status"] != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Timetable is already saved")
			return nil
		}
		var timeslotCount int64
		if err := s.db.QueryRow("SELECT COUNT(*) FROM timeslots WHERE timetable_id = ?", id).Scan(&timeslotCount); err != nil {
			return err
		}
		if timeslotCount == 0 {
			httpx.Error(w, http.StatusBadRequest, "Cannot save a timetable with no timeslots")
			return nil
		}
		groups, err := db.All(s.db, "SELECT percentage FROM timetable_groups WHERE timetable_id = ?", id)
		if err != nil {
			return err
		}
		if len(groups) == 0 {
			httpx.Error(w, http.StatusBadRequest, "At least one group must be assigned")
			return nil
		}
		var total int64
		for _, g := range groups {
			total += toInt64(g["percentage"])
		}
		if total != 100 {
			httpx.Error(w, http.StatusBadRequest, fmt.Sprintf("Group percentages must add up to 100%% (currently %d%%)", total))
			return nil
		}
		if _, err := s.db.Exec("UPDATE timetables SET status = 'saved' WHERE id = ?", id); err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM timetables WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/timetables/{id}/set-default", func(w http.ResponseWriter, r *http.Request) error {
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		if !truthy(t["active"]) {
			httpx.Error(w, http.StatusBadRequest, "Cannot set an inactive timetable as default")
			return nil
		}
		if t["status"] != "saved" {
			httpx.Error(w, http.StatusBadRequest, "Only saved timetables can be set as default")
			return nil
		}
		err = s.db.InTx(func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE timetables SET is_default = 0 WHERE is_default = 1"); err != nil {
				return err
			}
			_, err := tx.Exec("UPDATE timetables SET is_default = 1 WHERE id = ?", r.PathValue("id"))
			return err
		})
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/timetables/{id}/toggle-active", func(w http.ResponseWriter, r *http.Request) error {
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		id := r.PathValue("id")
		newActive := int64(1)
		if truthy(t["active"]) {
			newActive = 0
		}
		if _, err := s.db.Exec("UPDATE timetables SET active = ? WHERE id = ?", newActive, id); err != nil {
			return err
		}
		// Deactivating the default timetable clears the default flag.
		if newActive == 0 && truthy(t["is_default"]) {
			if _, err := s.db.Exec("UPDATE timetables SET is_default = 0 WHERE id = ?", id); err != nil {
				return err
			}
		}
		httpx.OK(w, map[string]any{"success": true, "active": newActive})
		return nil
	})

	s.adminRoute("DELETE /api/timetables/{id}", func(w http.ResponseWriter, r *http.Request) error {
		if _, ok, err := s.loadTimetable(w, r); !ok || err != nil {
			return err
		}
		id := r.PathValue("id")
		var blocking int64
		if err := s.db.QueryRow(`
			SELECT COUNT(*) FROM training_sessions
			WHERE timetable_id = ? AND status IN ('invitations_sent', 'completed')`, id).Scan(&blocking); err != nil {
			return err
		}
		if blocking > 0 {
			httpx.Error(w, http.StatusBadRequest, "Cannot delete: timetable is attached to sessions with sent invitations or completed sessions")
			return nil
		}
		err := s.db.InTx(func(tx *sql.Tx) error {
			// Reset scheduled sessions that use this timetable back to draft.
			scheduled, err := db.All(tx, "SELECT id FROM training_sessions WHERE timetable_id = ? AND status = 'scheduled'", id)
			if err != nil {
				return err
			}
			for _, sess := range scheduled {
				if _, err := tx.Exec("DELETE FROM invitations WHERE session_id = ?", sess["id"]); err != nil {
					return err
				}
				if _, err := tx.Exec("UPDATE training_sessions SET status = 'draft', timetable_id = NULL WHERE id = ?", sess["id"]); err != nil {
					return err
				}
			}
			if _, err := tx.Exec("UPDATE training_sessions SET timetable_id = NULL WHERE timetable_id = ? AND status = 'draft'", id); err != nil {
				return err
			}
			// Deleting the timetable cascades to its timeslots.
			_, err = tx.Exec("DELETE FROM timetables WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("PUT /api/timetables/{id}/groups", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		groups, isArray := b["groups"].([]any)
		if !isArray {
			httpx.Error(w, http.StatusBadRequest, "groups array is required")
			return nil
		}
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		if t["status"] != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify groups of a saved timetable")
			return nil
		}
		id := r.PathValue("id")
		err = s.db.InTx(func(tx *sql.Tx) error {
			if _, err := tx.Exec("DELETE FROM timetable_groups WHERE timetable_id = ?", id); err != nil {
				return err
			}
			for i, g := range groups {
				m, _ := g.(map[string]any)
				if _, err := tx.Exec("INSERT INTO timetable_groups (timetable_id, group_id, percentage, position) VALUES (?, ?, ?, ?)",
					id, arg(m["group_id"]), arg(m["percentage"]), i); err != nil {
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

	s.adminRoute("PUT /api/timetables/{id}/groups/reorder", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		groupIDs, isArray := b["group_ids"].([]any)
		if !isArray {
			httpx.Error(w, http.StatusBadRequest, "group_ids array is required")
			return nil
		}
		if _, ok, err := s.loadTimetable(w, r); !ok || err != nil {
			return err
		}
		id := r.PathValue("id")
		err := s.db.InTx(func(tx *sql.Tx) error {
			for i, gid := range groupIDs {
				if _, err := tx.Exec("UPDATE timetable_groups SET position = ? WHERE timetable_id = ? AND group_id = ?", i, id, arg(gid)); err != nil {
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

	s.adminRoute("POST /api/timetables/{id}/timeslots", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		if !truthy(b["start_time"]) {
			httpx.Error(w, http.StatusBadRequest, "start_time is required")
			return nil
		}
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		if t["status"] != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify timeslots of a saved timetable")
			return nil
		}
		res, err := s.db.Exec("INSERT INTO timeslots (timetable_id, start_time) VALUES (?, ?)", r.PathValue("id"), arg(b["start_time"]))
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A timeslot with this start time already exists in this timetable")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM timeslots WHERE id = ?", lastID(res))
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("DELETE /api/timetables/{id}/timeslots/{timeslotId}", func(w http.ResponseWriter, r *http.Request) error {
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		if t["status"] != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify timeslots of a saved timetable")
			return nil
		}
		res, err := s.db.Exec("DELETE FROM timeslots WHERE id = ? AND timetable_id = ?", r.PathValue("timeslotId"), r.PathValue("id"))
		if err != nil {
			return err
		}
		if changes(res) == 0 {
			httpx.Error(w, http.StatusNotFound, "Timeslot not found")
			return nil
		}
		httpx.Success(w)
		return nil
	})
}

// loadTimetable fetches the timetable named by the {id} path value, writing a 404 if it
// does not exist. ok is false when the handler should stop.
func (s *Server) loadTimetable(w http.ResponseWriter, r *http.Request) (map[string]any, bool, error) {
	t, err := db.Get(s.db, "SELECT * FROM timetables WHERE id = ?", r.PathValue("id"))
	if err != nil {
		return nil, false, err
	}
	if t == nil {
		httpx.Error(w, http.StatusNotFound, "Timetable not found")
		return nil, false, nil
	}
	return t, true, nil
}
