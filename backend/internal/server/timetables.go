package server

import (
	"database/sql"
	"fmt"
	"net/http"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/scheduling"
)

type Timetable struct {
	ID        int64  `db:"id" json:"id"`
	Name      string `db:"name" json:"name"`
	Status    string `db:"status" json:"status"` // draft or saved
	IsDefault int64  `db:"is_default" json:"is_default"`
	Active    int64  `db:"active" json:"active"`
}

func (s *Server) getTimetable(id any) (Timetable, bool, error) {
	return db.One[Timetable](s.db, "SELECT id, name, status, is_default, active FROM timetables WHERE id = ?", id)
}

type Timeslot struct {
	ID          int64  `db:"id" json:"id"`
	TimetableID int64  `db:"timetable_id" json:"timetable_id"`
	StartTime   string `db:"start_time" json:"start_time"`
}

// timetableTimeslots lists a timetable's timeslots, earliest first.
func (s *Server) timetableTimeslots(timetableID any) ([]Timeslot, error) {
	return db.Many[Timeslot](s.db, "SELECT id, timetable_id, start_time FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC", timetableID)
}

// TimetableGroup is a group's share of a timetable's slots.
type TimetableGroup struct {
	GroupID    int64  `db:"group_id" json:"group_id"`
	Percentage int64  `db:"percentage" json:"percentage"`
	GroupName  string `db:"group_name" json:"group_name"`
	GroupColor string `db:"group_color" json:"group_color"`
	IsDefault  int64  `db:"is_default" json:"is_default"`
}

// timetableGroups lists a timetable's groups in their configured order.
func (s *Server) timetableGroups(timetableID any) ([]TimetableGroup, error) {
	return db.Many[TimetableGroup](s.db, `
		SELECT tg.group_id, tg.percentage, g.name AS group_name, g.color AS group_color, g.is_default
		FROM timetable_groups tg
		JOIN groups g ON g.id = tg.group_id
		WHERE tg.timetable_id = ?
		ORDER BY tg.position ASC`, timetableID)
}

// schedulingGroups converts timetable groups to scheduling's input, keeping their order.
// Slots are left 0 (see scheduling.AllocateSlots).
func schedulingGroups(tgs []TimetableGroup) []scheduling.Group {
	out := make([]scheduling.Group, len(tgs))
	for i, tg := range tgs {
		out[i] = scheduling.Group{ID: tg.GroupID, Percentage: float64(tg.Percentage)}
	}
	return out
}

func (s *Server) timetableRoutes() {
	s.adminRoute("GET /api/timetables", func(w http.ResponseWriter, r *http.Request) error {
		type timetableWithCount struct {
			Timetable
			TimeslotCount int64 `db:"timeslot_count" json:"timeslot_count"`
		}
		timetables, err := db.Many[timetableWithCount](s.db, `
			SELECT t.id, t.name, t.status, t.is_default, t.active,
				(SELECT COUNT(*) FROM timeslots WHERE timetable_id = t.id) AS timeslot_count
			FROM timetables t
			ORDER BY t.created_at DESC`)
		if err != nil {
			return err
		}
		httpx.OK(w, timetables)
		return nil
	})

	s.adminRoute("GET /api/timetables/{id}", func(w http.ResponseWriter, r *http.Request) error {
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		timeslots, err := s.timetableTimeslots(t.ID)
		if err != nil {
			return err
		}
		groups, err := s.timetableGroups(t.ID)
		if err != nil {
			return err
		}
		httpx.OK(w, struct {
			Timetable
			Timeslots []Timeslot       `json:"timeslots"`
			Groups    []TimetableGroup `json:"groups"`
		}{t, timeslots, groups})
		return nil
	})

	s.adminRoute("POST /api/timetables", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Name string `json:"name"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.Name == "" {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}
		res, err := s.db.Exec("INSERT INTO timetables (name) VALUES (?)", in.Name)
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
		row, _, err := s.getTimetable(id)
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
		type request struct {
			Name *string `json:"name"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		id := r.PathValue("id")
		if in.Name != nil {
			if t.Status != "draft" {
				httpx.Error(w, http.StatusBadRequest, "Cannot edit a saved timetable")
				return nil
			}
			if _, err := s.db.Exec("UPDATE timetables SET name = ? WHERE id = ?", *in.Name, id); err != nil {
				return err
			}
		}
		row, _, err := s.getTimetable(id)
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
		if t.Status != "draft" {
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
		percentages, err := db.Many[int64](s.db, "SELECT percentage FROM timetable_groups WHERE timetable_id = ?", id)
		if err != nil {
			return err
		}
		if len(percentages) == 0 {
			httpx.Error(w, http.StatusBadRequest, "At least one group must be assigned")
			return nil
		}
		var total int64
		for _, p := range percentages {
			total += p
		}
		if total != 100 {
			httpx.Error(w, http.StatusBadRequest, fmt.Sprintf("Group percentages must add up to 100%% (currently %d%%)", total))
			return nil
		}
		if _, err := s.db.Exec("UPDATE timetables SET status = 'saved' WHERE id = ?", id); err != nil {
			return err
		}
		row, _, err := s.getTimetable(id)
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
		if t.Active == 0 {
			httpx.Error(w, http.StatusBadRequest, "Cannot set an inactive timetable as default")
			return nil
		}
		if t.Status != "saved" {
			httpx.Error(w, http.StatusBadRequest, "Only saved timetables can be set as default")
			return nil
		}
		err = s.db.InTx(func(tx *sqlx.Tx) error {
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
		if t.Active != 0 {
			newActive = 0
		}
		if _, err := s.db.Exec("UPDATE timetables SET active = ? WHERE id = ?", newActive, id); err != nil {
			return err
		}
		// Deactivating the default timetable clears the default flag.
		if newActive == 0 && t.IsDefault != 0 {
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
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			// Reset scheduled sessions that use this timetable back to draft.
			scheduled, err := db.Many[int64](tx, "SELECT id FROM training_sessions WHERE timetable_id = ? AND status = 'scheduled'", id)
			if err != nil {
				return err
			}
			for _, sessionID := range scheduled {
				if _, err := tx.Exec("DELETE FROM invitations WHERE session_id = ?", sessionID); err != nil {
					return err
				}
				if _, err := tx.Exec("UPDATE training_sessions SET status = 'draft', timetable_id = NULL WHERE id = ?", sessionID); err != nil {
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
		type request struct {
			Groups []struct {
				GroupID    int64 `json:"group_id"`
				Percentage int64 `json:"percentage"`
			} `json:"groups"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.Groups == nil {
			httpx.Error(w, http.StatusBadRequest, "groups array is required")
			return nil
		}
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		if t.Status != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify groups of a saved timetable")
			return nil
		}
		id := r.PathValue("id")
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			if _, err := tx.Exec("DELETE FROM timetable_groups WHERE timetable_id = ?", id); err != nil {
				return err
			}
			for i, g := range in.Groups {
				if _, err := tx.Exec("INSERT INTO timetable_groups (timetable_id, group_id, percentage, position) VALUES (?, ?, ?, ?)",
					id, g.GroupID, g.Percentage, i); err != nil {
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
		if _, ok, err := s.loadTimetable(w, r); !ok || err != nil {
			return err
		}
		id := r.PathValue("id")
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			for i, gid := range in.GroupIDs {
				if _, err := tx.Exec("UPDATE timetable_groups SET position = ? WHERE timetable_id = ? AND group_id = ?", i, id, gid); err != nil {
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
		type request struct {
			StartTime string `json:"start_time"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.StartTime == "" {
			httpx.Error(w, http.StatusBadRequest, "start_time is required")
			return nil
		}
		t, ok, err := s.loadTimetable(w, r)
		if !ok || err != nil {
			return err
		}
		if t.Status != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify timeslots of a saved timetable")
			return nil
		}
		res, err := s.db.Exec("INSERT INTO timeslots (timetable_id, start_time) VALUES (?, ?)", r.PathValue("id"), in.StartTime)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A timeslot with this start time already exists in this timetable")
			return nil
		}
		if err != nil {
			return err
		}
		row, _, err := db.One[Timeslot](s.db, "SELECT id, timetable_id, start_time FROM timeslots WHERE id = ?", lastID(res))
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
		if t.Status != "draft" {
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
func (s *Server) loadTimetable(w http.ResponseWriter, r *http.Request) (Timetable, bool, error) {
	t, found, err := s.getTimetable(r.PathValue("id"))
	if err != nil || !found {
		if err == nil {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
		}
		return t, false, err
	}
	return t, true, nil
}

// timeslotPrefs holds, per student, the timeslots of one timetable they prefer. A student
// without preferences may take any timeslot. Load it with Server.timeslotPrefs.
type timeslotPrefs map[int64]map[int64]bool

func (s *Server) timeslotPrefs(timetableID int64) (timeslotPrefs, error) {
	type preference struct {
		StudentID  int64 `db:"student_id"`
		TimeslotID int64 `db:"timeslot_id"`
	}
	preferences, err := db.Many[preference](s.db, "SELECT student_id, timeslot_id FROM student_preferred_timeslots WHERE timetable_id = ?", timetableID)
	if err != nil {
		return nil, err
	}
	out := timeslotPrefs{}
	for _, p := range preferences {
		if out[p.StudentID] == nil {
			out[p.StudentID] = map[int64]bool{}
		}
		out[p.StudentID][p.TimeslotID] = true
	}
	return out, nil
}

// allows reports whether the student may take the timeslot.
func (p timeslotPrefs) allows(studentID, timeslotID int64) bool {
	prefs := p[studentID]
	return len(prefs) == 0 || prefs[timeslotID]
}

// startTimes lists the start times of the student's preferred timeslots, in timeslot order.
// It is nil (null in a decision log) when they have no preferences.
func (p timeslotPrefs) startTimes(studentID int64, timeslots []Timeslot) []string {
	prefs := p[studentID]
	if len(prefs) == 0 {
		return nil
	}
	list := []string{}
	for _, t := range timeslots {
		if prefs[t.ID] {
			list = append(list, t.StartTime)
		}
	}
	return list
}
