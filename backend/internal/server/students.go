package server

import (
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

func (s *Server) studentRoutes() {
	s.adminRoute("GET /api/students", s.handleListStudents)

	s.adminRoute("GET /api/students/export", func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.All(s.db, "SELECT first_name, last_name, email, membership_id, attended_sessions, no_show_count, preferred_days, active FROM students WHERE deleted_at IS NULL ORDER BY last_name ASC, first_name ASC")
		if err != nil {
			return err
		}
		lines := make([]string, len(rows))
		for i, row := range rows {
			lines[i] = csvRow(row["first_name"], row["last_name"], row["email"], row["membership_id"],
				row["attended_sessions"], row["no_show_count"], row["preferred_days"], row["active"])
		}
		writeCSV(w, "students.csv", "first_name,last_name,email,membership_id,attended_sessions,no_show_count,preferred_days,active", lines)
		return nil
	})

	s.adminRoute("POST /api/students/import", s.handleImportStudents)

	s.adminRoute("GET /api/students/{id}", func(w http.ResponseWriter, r *http.Request) error {
		row, err := db.Get(s.db, "SELECT * FROM students WHERE id = ? AND deleted_at IS NULL", r.PathValue("id"))
		if err != nil {
			return err
		}
		if row == nil {
			httpx.Error(w, http.StatusNotFound, "Student not found")
			return nil
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("GET /api/students/{id}/invitations", func(w http.ResponseWriter, r *http.Request) error {
		if !s.requireStudent(w, r) {
			return nil
		}
		rows, err := db.All(s.db, `
			SELECT i.id, i.status, ts.date AS session_date, tsl.start_time
			FROM invitations i
			JOIN training_sessions ts ON ts.id = i.session_id
			JOIN timeslots tsl ON tsl.id = i.timeslot_id
			WHERE i.student_id = ? AND i.status IN ('confirmed', 'invited', 'scheduled')
				AND ts.status != 'completed'
			ORDER BY ts.date ASC, tsl.start_time ASC`, r.PathValue("id"))
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
		return nil
	})

	s.adminRoute("GET /api/students/{id}/invitation-history", func(w http.ResponseWriter, r *http.Request) error {
		if !s.requireStudent(w, r) {
			return nil
		}
		rows, err := db.All(s.db, `
			SELECT i.id, i.status, i.invited_at, i.responded_at,
				ts.date AS session_date, tsl.start_time,
				d.name AS discipline_name,
				g.name AS group_name, g.color AS group_color
			FROM invitations i
			JOIN training_sessions ts ON ts.id = i.session_id
			JOIN timeslots tsl ON tsl.id = i.timeslot_id
			LEFT JOIN disciplines d ON d.id = i.discipline_id
			LEFT JOIN groups g ON g.id = i.group_id
			WHERE i.student_id = ?
			ORDER BY i.invited_at DESC, ts.date DESC, tsl.start_time DESC`, r.PathValue("id"))
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
		return nil
	})

	s.adminRoute("POST /api/students", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		if !truthy(b["first_name"]) || !truthy(b["last_name"]) || !truthy(b["email"]) {
			httpx.Error(w, http.StatusBadRequest, "First name, last name and email are required")
			return nil
		}
		membershipID := any("")
		if truthy(b["membership_id"]) {
			membershipID = arg(b["membership_id"])
		}
		res, err := s.db.Exec("INSERT INTO students (first_name, last_name, email, membership_id) VALUES (?, ?, ?, ?)",
			arg(b["first_name"]), arg(b["last_name"]), arg(b["email"]), membershipID)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A student with this email already exists")
			return nil
		}
		if err != nil {
			return err
		}
		studentID := lastID(res)
		// Auto-add to the default group.
		var defaultGroup int64
		switch err := s.db.QueryRow("SELECT id FROM groups WHERE is_default = 1").Scan(&defaultGroup); err {
		case nil:
			if _, err := s.db.Exec("INSERT OR IGNORE INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))", studentID, defaultGroup); err != nil {
				return err
			}
		case sql.ErrNoRows:
		default:
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM students WHERE id = ?", studentID)
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/students/{id}", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		id := r.PathValue("id")
		student, err := db.Get(s.db, "SELECT * FROM students WHERE id = ? AND deleted_at IS NULL", id)
		if err != nil {
			return err
		}
		if student == nil {
			httpx.Error(w, http.StatusNotFound, "Student not found")
			return nil
		}
		err = s.db.InTx(func(tx *sql.Tx) error {
			if _, err := tx.Exec(`
				UPDATE students SET
					first_name = COALESCE(?, first_name),
					last_name = COALESCE(?, last_name),
					email = COALESCE(?, email),
					membership_id = COALESCE(?, membership_id),
					attended_sessions = COALESCE(?, attended_sessions),
					active = COALESCE(?, active),
					preferred_days = COALESCE(?, preferred_days)
				WHERE id = ?`,
				arg(b["first_name"]), arg(b["last_name"]), arg(b["email"]), arg(b["membership_id"]),
				arg(b["attended_sessions"]), arg(b["active"]), arg(b["preferred_days"]), id); err != nil {
				return err
			}
			// Reactivation (strictly active: 1 over a stored 0) moves the queue position.
			if b["active"] == float64(1) && student["active"] == int64(0) {
				if _, err := tx.Exec("UPDATE student_groups SET reactivated_at = datetime('now') WHERE student_id = ?", id); err != nil {
					return err
				}
			}
			return nil
		})
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A student with this email already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM students WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/students/{id}", func(w http.ResponseWriter, r *http.Request) error {
		if !s.requireStudent(w, r) {
			return nil
		}
		id := r.PathValue("id")
		err := s.db.InTx(func(tx *sql.Tx) error {
			// Cancel any active (invited/scheduled) invitations for this student.
			if _, err := tx.Exec("UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE student_id = ? AND status IN ('invited', 'scheduled')", id); err != nil {
				return err
			}
			// Soft-delete: mark as deleted and deactivate.
			_, err := tx.Exec("UPDATE students SET deleted_at = datetime('now'), active = 0 WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("GET /api/students/{id}/preferred-timeslots", func(w http.ResponseWriter, r *http.Request) error {
		if !s.requireStudent(w, r) {
			return nil
		}
		rows, err := db.All(s.db, "SELECT timetable_id, timeslot_id FROM student_preferred_timeslots WHERE student_id = ?", r.PathValue("id"))
		if err != nil {
			return err
		}
		byTimetable := map[string][]any{}
		for _, row := range rows {
			key := strconv.FormatInt(toInt64(row["timetable_id"]), 10)
			byTimetable[key] = append(byTimetable[key], row["timeslot_id"])
		}
		httpx.OK(w, byTimetable)
		return nil
	})

	s.adminRoute("PUT /api/students/{id}/preferred-timeslots/{timetableId}", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		timeslotIDs, isArray := b["timeslot_ids"].([]any)
		if !isArray {
			httpx.Error(w, http.StatusBadRequest, "timeslot_ids array is required")
			return nil
		}
		if !s.requireStudent(w, r) {
			return nil
		}
		id, timetableID := r.PathValue("id"), r.PathValue("timetableId")
		if !s.exists("SELECT 1 FROM timetables WHERE id = ?", timetableID) {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}
		all, err := db.All(s.db, "SELECT id FROM timeslots WHERE timetable_id = ?", timetableID)
		if err != nil {
			return err
		}
		allIDs := make(map[float64]bool, len(all))
		for _, t := range all {
			allIDs[float64(toInt64(t["id"]))] = true
		}
		err = s.db.InTx(func(tx *sql.Tx) error {
			if _, err := tx.Exec("DELETE FROM student_preferred_timeslots WHERE student_id = ? AND timetable_id = ?", id, timetableID); err != nil {
				return err
			}
			// Selecting every timeslot is stored as no preference (= all).
			if len(timeslotIDs) >= len(allIDs) {
				return nil
			}
			for _, tsID := range timeslotIDs {
				n, isNum := tsID.(float64) // Set.has() is strict: string ids never match
				if !isNum || !allIDs[n] {
					continue
				}
				if _, err := tx.Exec("INSERT INTO student_preferred_timeslots (student_id, timeslot_id, timetable_id) VALUES (?, ?, ?)", id, arg(n), timetableID); err != nil {
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

	s.adminRoute("GET /api/students/{id}/groups", func(w http.ResponseWriter, r *http.Request) error {
		if !s.requireStudent(w, r) {
			return nil
		}
		row, err := db.Get(s.db, `
			SELECT g.id, g.name, g.is_default FROM groups g
			JOIN student_groups sg ON sg.group_id = g.id
			WHERE sg.student_id = ?`, r.PathValue("id"))
		if err != nil {
			return err
		}
		httpx.OK(w, row) // nil map encodes as null, like `group || null`
		return nil
	})

	s.adminRoute("PUT /api/students/{id}/groups", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		if !s.requireStudent(w, r) {
			return nil
		}
		id := r.PathValue("id")
		err := s.db.InTx(func(tx *sql.Tx) error {
			if _, err := tx.Exec("DELETE FROM student_groups WHERE student_id = ?", id); err != nil {
				return err
			}
			if truthy(b["group_id"]) {
				_, err := tx.Exec("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))", id, arg(b["group_id"]))
				return err
			}
			return nil
		})
		if err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("PUT /api/students/{id}/cooldown", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		days, isNum := b["days"].(float64)
		if !isNum || days <= 0 {
			httpx.Error(w, http.StatusBadRequest, "A positive number of days is required")
			return nil
		}
		if !s.requireStudent(w, r) {
			return nil
		}
		id := r.PathValue("id")
		// new Date(Date.now() + days * 864e5).toISOString() truncated to whole seconds, UTC.
		ms := math.Trunc(float64(time.Now().UnixMilli()) + days*24*60*60*1000)
		cooldownUntil := time.UnixMilli(int64(ms)).UTC().Format(time.DateTime)
		if _, err := s.db.Exec("UPDATE students SET cooldown_until = ? WHERE id = ?", cooldownUntil, id); err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM students WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/students/{id}/cooldown", func(w http.ResponseWriter, r *http.Request) error {
		if !s.requireStudent(w, r) {
			return nil
		}
		id := r.PathValue("id")
		// End the cooldown now rather than erasing it, so its end still counts for the queue position.
		if _, err := s.db.Exec("UPDATE students SET cooldown_until = datetime('now') WHERE id = ? AND cooldown_until > datetime('now')", id); err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM students WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})
}

// requireStudent writes a 404 unless the {id} path value names a non-deleted student.
func (s *Server) requireStudent(w http.ResponseWriter, r *http.Request) bool {
	if s.exists("SELECT 1 FROM students WHERE id = ? AND deleted_at IS NULL", r.PathValue("id")) {
		return true
	}
	httpx.Error(w, http.StatusNotFound, "Student not found")
	return false
}

func (s *Server) handleListStudents(w http.ResponseWriter, r *http.Request) error {
	students, err := db.All(s.db, "SELECT * FROM students WHERE deleted_at IS NULL ORDER BY last_name ASC, first_name ASC")
	if err != nil {
		return err
	}
	memberships, err := db.All(s.db, `
		SELECT sg.student_id, g.id AS group_id, g.name AS group_name, g.color AS group_color
		FROM student_groups sg
		JOIN groups g ON g.id = sg.group_id`)
	if err != nil {
		return err
	}
	groupByStudent := map[int64]map[string]any{}
	for _, m := range memberships {
		groupByStudent[toInt64(m["student_id"])] = map[string]any{"id": m["group_id"], "name": m["group_name"], "color": m["group_color"]}
	}

	buddyRows, err := db.All(s.db, "SELECT bgm.student_id, bgm.buddy_group_id FROM buddy_group_members bgm")
	if err != nil {
		return err
	}
	firstNameByID := make(map[int64]string, len(students))
	for _, st := range students {
		firstNameByID[toInt64(st["id"])], _ = st["first_name"].(string)
	}
	// Buddy group names are the listed (non-deleted) members' first names.
	namesByBuddyGroup := map[int64][]string{}
	for _, m := range buddyRows {
		if name, ok := firstNameByID[toInt64(m["student_id"])]; ok {
			gid := toInt64(m["buddy_group_id"])
			namesByBuddyGroup[gid] = append(namesByBuddyGroup[gid], name)
		}
	}
	buddyByStudent := map[int64]map[string]any{}
	for _, m := range buddyRows {
		gid := toInt64(m["buddy_group_id"])
		buddyByStudent[toInt64(m["student_id"])] = map[string]any{"id": m["buddy_group_id"], "name": strings.Join(namesByBuddyGroup[gid], " & ")}
	}

	for _, st := range students {
		id := toInt64(st["id"])
		if g, ok := groupByStudent[id]; ok {
			st["group"] = g
		} else {
			st["group"] = nil
		}
		if bg, ok := buddyByStudent[id]; ok {
			st["buddy_group"] = bg
		} else {
			st["buddy_group"] = nil
		}
	}
	httpx.OK(w, students)
	return nil
}

func (s *Server) handleImportStudents(w http.ResponseWriter, r *http.Request) error {
	lines, ok := readCSVImport(w, r)
	if !ok {
		return nil
	}
	header := csvHeader(lines[0])
	idx := func(name string) int { return indexOf(header, name) }
	firstIdx, lastIdx, emailIdx := idx("first_name"), idx("last_name"), idx("email")
	if firstIdx == -1 || lastIdx == -1 || emailIdx == -1 {
		httpx.Error(w, http.StatusBadRequest, "CSV must contain first_name, last_name, and email columns")
		return nil
	}
	membershipIdx, attendedIdx, noShowIdx, daysIdx, activeIdx := idx("membership_id"), idx("attended_sessions"), idx("no_show_count"), idx("preferred_days"), idx("active")

	result := importResult{Errors: []string{}}
	err := s.db.InTx(func(tx *sql.Tx) error {
		var defaultGroup int64
		switch err := tx.QueryRow("SELECT id FROM groups WHERE is_default = 1").Scan(&defaultGroup); err {
		case nil, sql.ErrNoRows:
		default:
			return err
		}

		for i := 1; i < len(lines); i++ {
			fields := parseCSVLine(lines[i])
			first, last, email := field(fields, firstIdx), field(fields, lastIdx), field(fields, emailIdx)
			if first == "" || last == "" || email == "" {
				result.Errors = append(result.Errors, fmt.Sprintf("Row %d: missing required fields", i+1))
				result.Skipped++
				continue
			}
			membershipID := field(fields, membershipIdx)

			// Optional columns: only written when present and valid (like the TS `!isNaN` checks).
			var cols []string
			var vals []any
			if n, ok := jsParseInt(field(fields, attendedIdx)); ok && attendedIdx != -1 {
				cols, vals = append(cols, "attended_sessions"), append(vals, n)
			}
			if n, ok := jsParseInt(field(fields, noShowIdx)); ok && noShowIdx != -1 {
				cols, vals = append(cols, "no_show_count"), append(vals, n)
			}
			if d := field(fields, daysIdx); d != "" {
				cols, vals = append(cols, "preferred_days"), append(vals, d)
			}
			if n, ok := jsParseInt(field(fields, activeIdx)); ok && activeIdx != -1 {
				cols, vals = append(cols, "active"), append(vals, n)
			}

			if err := importStudentRow(tx, first, last, email, membershipID, cols, vals, defaultGroup); err != nil {
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
}

// importStudentRow updates the student with this email, or inserts a new one, and puts them
// in the default group (if any) when they have no group yet.
func importStudentRow(tx *sql.Tx, first, last, email, membershipID string, cols []string, vals []any, defaultGroup int64) error {
	var existing int64
	switch err := tx.QueryRow("SELECT id FROM students WHERE email = ? AND deleted_at IS NULL", email).Scan(&existing); err {
	case nil:
		set := "first_name = ?, last_name = ?, membership_id = ?"
		for _, c := range cols {
			set += ", " + c + " = ?"
		}
		a := append([]any{first, last, membershipID}, vals...)
		if _, err := tx.Exec("UPDATE students SET "+set+" WHERE id = ?", append(a, existing)...); err != nil {
			return err
		}
		if defaultGroup != 0 {
			var one int
			switch err := tx.QueryRow("SELECT 1 FROM student_groups WHERE student_id = ?", existing).Scan(&one); err {
			case sql.ErrNoRows:
				_, err := tx.Exec("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))", existing, defaultGroup)
				return err
			default:
				return err
			}
		}
		return nil
	case sql.ErrNoRows:
		names := append([]string{"first_name", "last_name", "email", "membership_id"}, cols...)
		a := append([]any{first, last, email, membershipID}, vals...)
		res, err := tx.Exec("INSERT INTO students ("+strings.Join(names, ", ")+") VALUES ("+placeholders(len(names))+")", a...)
		if err != nil {
			return err
		}
		if defaultGroup != 0 {
			_, err := tx.Exec("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))", lastID(res), defaultGroup)
			return err
		}
		return nil
	default:
		return err
	}
}
