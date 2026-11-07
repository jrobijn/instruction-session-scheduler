package server

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

func (s *Server) groupRoutes() {
	s.adminRoute("GET /api/groups", func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.All(s.db, `
			SELECT g.*,
				(SELECT COUNT(*) FROM student_groups WHERE group_id = g.id) AS member_count,
				(SELECT COUNT(*) FROM discipline_groups WHERE group_id = g.id) AS discipline_count
			FROM groups g
			ORDER BY g.name ASC`)
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
		return nil
	})

	s.adminRoute("GET /api/groups/export", func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.All(s.db, "SELECT name, is_default, active FROM groups ORDER BY name ASC")
		if err != nil {
			return err
		}
		lines := make([]string, len(rows))
		for i, row := range rows {
			lines[i] = csvRow(row["name"], row["is_default"], row["active"])
		}
		writeCSV(w, "groups.csv", "name,is_default,active", lines)
		return nil
	})

	s.adminRoute("POST /api/groups/import", func(w http.ResponseWriter, r *http.Request) error {
		lines, ok := readCSVImport(w, r)
		if !ok {
			return nil
		}
		nameIdx := indexOf(csvHeader(lines[0]), "name")
		if nameIdx == -1 {
			httpx.Error(w, http.StatusBadRequest, "CSV must contain a name column")
			return nil
		}
		result := importResult{Errors: []string{}}
		err := s.db.InTx(func(tx *sql.Tx) error {
			for i := 1; i < len(lines); i++ {
				name := field(parseCSVLine(lines[i]), nameIdx)
				if name == "" {
					result.Errors = append(result.Errors, fmt.Sprintf("Row %d: missing name", i+1))
					result.Skipped++
					continue
				}
				var id int64
				switch err := tx.QueryRow("SELECT id FROM groups WHERE name = ?", name).Scan(&id); err {
				case nil:
					result.Skipped++
				case sql.ErrNoRows:
					if _, err := tx.Exec("INSERT INTO groups (name) VALUES (?)", name); err != nil {
						result.Errors = append(result.Errors, fmt.Sprintf("Row %d: %s", i+1, sqliteMessage(err)))
						result.Skipped++
					} else {
						result.Imported++
					}
				default:
					result.Errors = append(result.Errors, fmt.Sprintf("Row %d: %s", i+1, sqliteMessage(err)))
					result.Skipped++
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

	s.adminRoute("POST /api/groups", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		if !truthy(b["name"]) {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}
		color := any("#3b82f6")
		if truthy(b["color"]) {
			color = arg(b["color"])
		}
		res, err := s.db.Exec("INSERT INTO groups (name, color, new_member_priority, reactivated_member_priority, cooldown_member_priority) VALUES (?, ?, 'back', 'back', 'back')",
			arg(b["name"]), color)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A group with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM groups WHERE id = ?", lastID(res))
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/groups/{id}", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		for _, key := range []string{"new_member_priority", "reactivated_member_priority", "cooldown_member_priority"} {
			if v := b[key]; v != nil && v != "front" && v != "back" {
				httpx.Error(w, http.StatusBadRequest, key+" must be 'front' or 'back'")
				return nil
			}
		}
		_, err := s.db.Exec(`
			UPDATE groups SET
				name = COALESCE(?, name),
				active = COALESCE(?, active),
				color = COALESCE(?, color),
				new_member_priority = COALESCE(?, new_member_priority),
				reactivated_member_priority = COALESCE(?, reactivated_member_priority),
				cooldown_member_priority = COALESCE(?, cooldown_member_priority)
			WHERE id = ?`,
			arg(b["name"]), arg(b["active"]), arg(b["color"]),
			arg(b["new_member_priority"]), arg(b["reactivated_member_priority"]), arg(b["cooldown_member_priority"]), id)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A group with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/groups/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if s.exists("SELECT 1 FROM timetable_groups WHERE group_id = ?", id) {
			httpx.Error(w, http.StatusBadRequest, "Cannot delete a group that is assigned to timetables")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM groups WHERE id = ?", id); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/set-default", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		err := s.db.InTx(func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE groups SET is_default = 0 WHERE is_default = 1"); err != nil {
				return err
			}
			_, err := tx.Exec("UPDATE groups SET is_default = 1 WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/unset-default", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if _, err := s.db.Exec("UPDATE groups SET is_default = 0 WHERE id = ?", id); err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("GET /api/groups/{id}/members", s.handleGroupMembers)

	s.adminRoute("POST /api/groups/{id}/members", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		studentID := b["student_id"]
		if !truthy(studentID) {
			httpx.Error(w, http.StatusBadRequest, "student_id is required")
			return nil
		}
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if !s.exists("SELECT 1 FROM students WHERE id = ? AND deleted_at IS NULL", arg(studentID)) {
			httpx.Error(w, http.StatusNotFound, "Student not found")
			return nil
		}
		err := s.db.InTx(func(tx *sql.Tx) error {
			if _, err := tx.Exec("DELETE FROM student_groups WHERE student_id = ?", arg(studentID)); err != nil {
				return err
			}
			_, err := tx.Exec("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))", arg(studentID), id)
			return err
		})
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	// Toggle "invite next": the member jumps the queue until they get a counted invitation.
	s.adminRoute("PUT /api/groups/{id}/members/{studentId}/invite-next", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		enabled, isBool := b["enabled"].(bool)
		if !isBool {
			httpx.Error(w, http.StatusBadRequest, "enabled (boolean) is required")
			return nil
		}
		value := "NULL"
		if enabled {
			value = "datetime('now')"
		}
		res, err := s.db.Exec("UPDATE student_groups SET invite_next_at = "+value+" WHERE group_id = ? AND student_id = ?",
			r.PathValue("id"), r.PathValue("studentId"))
		if err != nil {
			return err
		}
		if changes(res) == 0 {
			httpx.Error(w, http.StatusNotFound, "Member not found")
			return nil
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/groups/{id}/members/{studentId}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM student_groups WHERE student_id = ? AND group_id = ?", r.PathValue("studentId"), id); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("GET /api/groups/{id}/non-members", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if q == "" {
			httpx.OK(w, []any{})
			return nil
		}
		like := "%" + q + "%"
		rows, err := db.All(s.db, `
			SELECT s.id, s.first_name, s.last_name, s.email,
				(SELECT g.name FROM student_groups sg JOIN groups g ON g.id = sg.group_id WHERE sg.student_id = s.id) AS current_group_name
			FROM students s
			WHERE s.active = 1
				AND s.deleted_at IS NULL
				AND s.id NOT IN (SELECT student_id FROM student_groups WHERE group_id = ?)
				AND (s.first_name || ' ' || s.last_name LIKE ? OR s.email LIKE ?)
			ORDER BY s.last_name ASC, s.first_name ASC
			LIMIT 20`, id, like, like)
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
		return nil
	})

	s.adminRoute("GET /api/groups/{id}/disciplines", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		rows, err := db.All(s.db, `
			SELECT d.id, d.name, d.abbreviation, d.active
			FROM disciplines d
			JOIN discipline_groups dg ON dg.discipline_id = d.id
			WHERE dg.group_id = ?
			ORDER BY d.name ASC`, id)
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/disciplines/{disciplineId}", func(w http.ResponseWriter, r *http.Request) error {
		id, disciplineID := r.PathValue("id"), r.PathValue("disciplineId")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if !s.exists("SELECT 1 FROM disciplines WHERE id = ?", disciplineID) {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		_, err := s.db.Exec("INSERT INTO discipline_groups (discipline_id, group_id) VALUES (?, ?)", disciplineID, id)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "Already assigned")
			return nil
		}
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/groups/{id}/disciplines/{disciplineId}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM discipline_groups WHERE discipline_id = ? AND group_id = ?", r.PathValue("disciplineId"), id); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})
}

// handleGroupMembers lists a group's members in queue order, with queue position, override
// reason and buddy group details.
func (s *Server) handleGroupMembers(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
		httpx.Error(w, http.StatusNotFound, "Group not found")
		return nil
	}
	members, err := db.All(s.db, `
		SELECT s.id, s.first_name, s.last_name, s.email, s.active, s.cooldown_until, s.preferred_days,
			`+queue.ColumnsSQL+`,
			sg.joined_at, sg.reactivated_at,
			qg.new_member_priority AS new_policy, qg.reactivated_member_priority AS reactivated_policy,
			qg.cooldown_member_priority AS cooldown_policy,
			bgm.buddy_group_id AS buddy_group_id,
			(SELECT COUNT(*) FROM invitations i
				JOIN training_sessions ts ON ts.id = i.session_id
				WHERE i.student_id = s.id AND i.status IN ('confirmed', 'invited', 'scheduled')
					AND ts.status != 'completed') AS active_invitations
		FROM students s
		JOIN student_groups sg ON sg.student_id = s.id
		`+queue.JoinSQL+`
		LEFT JOIN buddy_group_members bgm ON bgm.student_id = s.id
		WHERE sg.group_id = ? AND s.deleted_at IS NULL
		ORDER BY s.active DESC, `+queue.OrderSQL+`, s.last_name ASC, s.first_name ASC`, id)
	if err != nil {
		return err
	}

	// Buddy group names are built from member first names (matches the students list).
	buddies, err := db.All(s.db, `
		SELECT bgm.student_id, bgm.buddy_group_id, s.first_name, s.last_name, sg.group_id, g.name AS group_name
		FROM buddy_group_members bgm
		JOIN students s ON s.id = bgm.student_id AND s.deleted_at IS NULL
		LEFT JOIN student_groups sg ON sg.student_id = s.id
		LEFT JOIN groups g ON g.id = sg.group_id`)
	if err != nil {
		return err
	}
	buddiesByGroup := map[int64][]map[string]any{}
	for _, b := range buddies {
		gid := toInt64(b["buddy_group_id"])
		buddiesByGroup[gid] = append(buddiesByGroup[gid], b)
	}

	position := int64(0)
	for _, m := range members {
		queueAt, _ := m["queue_at"].(string)
		lastTurn, _ := m["last_turn_at"].(string)
		// A 'back' policy only matters when its moment is what places the member (later than their last turn).
		var override any
		for _, o := range []struct{ reason, atKey, policyKey string }{
			{"joined", "joined_at", "new_policy"},
			{"reactivated", "reactivated_at", "reactivated_policy"},
			{"cooldown", "cooldown_until", "cooldown_policy"},
		} {
			at, _ := m[o.atKey].(string)
			if m[o.policyKey] == "back" && at != "" && at == queueAt && at > lastTurn {
				override = map[string]any{"reason": o.reason, "at": at}
				break
			}
		}

		var queuePosition any
		if truthy(m["active"]) {
			position++
			queuePosition = position
		}

		var buddyGroup any
		if bgID := m["buddy_group_id"]; truthy(bgID) {
			group := buddiesByGroup[toInt64(bgID)]
			names := make([]string, len(group))
			others := []map[string]any{}
			for i, b := range group {
				names[i], _ = b["first_name"].(string)
				if toInt64(b["student_id"]) != toInt64(m["id"]) {
					others = append(others, map[string]any{
						"id": b["student_id"], "first_name": b["first_name"], "last_name": b["last_name"],
						"group_id": b["group_id"], "group_name": b["group_name"],
					})
				}
			}
			buddyGroup = map[string]any{"id": bgID, "name": strings.Join(names, " & "), "buddies": others}
		}

		m["queue_position"] = queuePosition
		m["invite_next"] = m["invite_next_since"] != nil
		m["queue_override"] = override
		m["buddy_group"] = buddyGroup
		for _, k := range []string{"buddy_group_id", "queue_at", "invite_next_since", "joined_at", "reactivated_at", "new_policy", "reactivated_policy", "cooldown_policy"} {
			delete(m, k)
		}
	}
	httpx.OK(w, members)
	return nil
}
