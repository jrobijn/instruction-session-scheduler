package server

import (
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

// getTimetable loads the timetable with the given id, reporting whether there is one.
func (s *Server) getTimetable(id int64) (Timetable, bool, error) {
	return db.One[Timetable](s.db, "SELECT id, name, status, is_default, active FROM timetables WHERE id = ?", id)
}

type Timeslot struct {
	ID          int64  `db:"id" json:"id"`
	TimetableID int64  `db:"timetable_id" json:"timetable_id"`
	StartTime   string `db:"start_time" json:"start_time"`
}

// timetableTimeslots lists a timetable's timeslots, earliest first.
func timetableTimeslots(q db.Querier, timetableID int64) ([]Timeslot, error) {
	return db.Many[Timeslot](q, "SELECT id, timetable_id, start_time FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC", timetableID)
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
func timetableGroups(q db.Querier, timetableID int64) ([]TimetableGroup, error) {
	return db.Many[TimetableGroup](q, `
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
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		t, found, err := s.getTimetable(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		timeslots, err := timetableTimeslots(s.db, id)
		if err != nil {
			return err
		}
		groups, err := timetableGroups(s.db, id)
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
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		if in.Name == "" {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}
		row, err := db.Get[Timetable](s.db, "INSERT INTO timetables (name) VALUES (?) RETURNING id, name, status, is_default, active", in.Name)
		if err != nil {
			return err
		}
		// Auto-assign the default group at 100%.
		defaultGroup, found, err := db.One[int64](s.db, "SELECT id FROM groups WHERE is_default = 1")
		if err != nil {
			return err
		}
		if found {
			if _, err := s.db.Exec("INSERT INTO timetable_groups (timetable_id, group_id, percentage, position) VALUES (?, ?, 100, 0)", row.ID, defaultGroup); err != nil {
				return err
			}
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/timetables/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		t, found, err := s.getTimetable(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		type request struct {
			Name *string `json:"name"`
		}
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		if in.Name != nil {
			if t.Status != "draft" {
				httpx.Error(w, http.StatusBadRequest, "Cannot edit a saved timetable")
				return nil
			}
			if t, err = db.Get[Timetable](s.db, "UPDATE timetables SET name = ? WHERE id = ? RETURNING id, name, status, is_default, active", *in.Name, id); err != nil {
				return err
			}
		}
		httpx.OK(w, t)
		return nil
	})

	s.adminRoute("POST /api/timetables/{id}/save", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		t, found, err := s.getTimetable(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		if t.Status != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Timetable is already saved")
			return nil
		}
		timeslotCount, err := db.Get[int64](s.db, "SELECT COUNT(*) FROM timeslots WHERE timetable_id = ?", id)
		if err != nil {
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
		row, err := db.Get[Timetable](s.db, "UPDATE timetables SET status = 'saved' WHERE id = ? RETURNING id, name, status, is_default, active", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/timetables/{id}/set-default", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		t, found, err := s.getTimetable(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
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
			_, err := tx.Exec("UPDATE timetables SET is_default = 1 WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/timetables/{id}/toggle-active", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		// Deactivating clears the default flag. The right-hand sides see the
		// pre-update row, so `active = 1` in the CASE means "being deactivated".
		newActive, found, err := db.One[int64](s.db, `
			UPDATE timetables
			SET active = 1 - active,
			    is_default = CASE WHEN active = 1 THEN 0 ELSE is_default END
			WHERE id = ?
			RETURNING active`, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		httpx.OK(w, map[string]any{"success": true, "active": newActive})
		return nil
	})

	s.adminRoute("DELETE /api/timetables/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		_, found, err := db.One[int](s.db, "SELECT 1 FROM timetables WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		blocking, err := db.Get[int64](s.db, `
			SELECT COUNT(*) FROM training_sessions
			WHERE timetable_id = ? AND status IN ('invitations_sent', 'completed')`, id)
		if err != nil {
			return err
		}
		if blocking > 0 {
			httpx.Error(w, http.StatusBadRequest, "Cannot delete: timetable is attached to sessions with sent invitations or completed sessions")
			return nil
		}
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			// Reset scheduled sessions that use this timetable back to draft.
			if _, err := tx.Exec(`
				DELETE FROM invitations WHERE session_id IN (
					SELECT id FROM training_sessions WHERE timetable_id = ? AND status = 'scheduled'
				)`, id); err != nil {
				return err
			}
			if _, err := tx.Exec("UPDATE training_sessions SET status = 'draft' WHERE timetable_id = ? AND status = 'scheduled'", id); err != nil {
				return err
			}
			// Deleting the timetable cascades to its timeslots and nulls
			// training_sessions.timetable_id (ON DELETE SET NULL).
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
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		if in.Groups == nil {
			httpx.Error(w, http.StatusBadRequest, "groups array is required")
			return nil
		}
		seen := map[int64]bool{}
		for _, g := range in.Groups {
			if g.Percentage < 0 || g.Percentage > 100 {
				httpx.Error(w, http.StatusBadRequest, "Group percentages must be between 0 and 100")
				return nil
			}
			if seen[g.GroupID] {
				httpx.Error(w, http.StatusBadRequest, "Each group can only be assigned once")
				return nil
			}
			seen[g.GroupID] = true
		}
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		t, found, err := s.getTimetable(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		if t.Status != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify groups of a saved timetable")
			return nil
		}
		for _, g := range in.Groups {
			if _, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", g.GroupID); err != nil {
				return err
			} else if !found {
				httpx.Error(w, http.StatusBadRequest, "Invalid group")
				return nil
			}
		}
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
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		_, found, err := db.One[int](s.db, "SELECT 1 FROM timetables WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		err = s.db.InTx(func(tx *sqlx.Tx) error {
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
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}
		if in.StartTime == "" {
			httpx.Error(w, http.StatusBadRequest, "start_time is required")
			return nil
		}
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		t, found, err := s.getTimetable(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		if t.Status != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify timeslots of a saved timetable")
			return nil
		}
		row, err := db.Get[Timeslot](s.db, "INSERT INTO timeslots (timetable_id, start_time) VALUES (?, ?) RETURNING id, timetable_id, start_time", id, in.StartTime)
		if isUniqueErr(err, "timeslots.timetable_id", "timeslots.start_time") {
			httpx.Error(w, http.StatusConflict, "A timeslot with this start time already exists in this timetable")
			return nil
		}
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("DELETE /api/timetables/{id}/timeslots/{timeslotId}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		t, found, err := s.getTimetable(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		if t.Status != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify timeslots of a saved timetable")
			return nil
		}
		timeslotID, ok := pathID(r, "timeslotId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timeslot not found")
			return nil
		}
		res, err := s.db.Exec("DELETE FROM timeslots WHERE id = ? AND timetable_id = ?", timeslotID, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			httpx.Error(w, http.StatusNotFound, "Timeslot not found")
			return nil
		}
		httpx.Success(w)
		return nil
	})
}
