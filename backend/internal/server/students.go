package server

import (
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

type Student struct {
	ID               int64   `db:"id" json:"id"`
	FirstName        string  `db:"first_name" json:"first_name"`
	LastName         string  `db:"last_name" json:"last_name"`
	Email            string  `db:"email" json:"email"`
	MembershipID     string  `db:"membership_id" json:"membership_id"`
	AttendedSessions int64   `db:"attended_sessions" json:"attended_sessions"`
	NoShowCount      int64   `db:"no_show_count" json:"no_show_count"`
	PreferredDays    string  `db:"preferred_days" json:"preferred_days"` // weekday numbers joined by |, 0 = Sunday
	Active           int64   `db:"active" json:"active"`
	CooldownUntil    *string `db:"cooldown_until" json:"cooldown_until"`
}

func (s *Server) listStudents() ([]Student, error) {
	return db.Many[Student](s.db, `
		SELECT id, first_name, last_name, email, membership_id, attended_sessions, no_show_count,
			preferred_days, active, cooldown_until
		FROM students
		WHERE deleted_at IS NULL
		ORDER BY last_name ASC, first_name ASC`)
}

// getStudent loads a (non-deleted) student; found is false if there is none.
func (s *Server) getStudent(id any) (Student, bool, error) {
	return db.One[Student](s.db, `
		SELECT id, first_name, last_name, email, membership_id, attended_sessions, no_show_count,
			preferred_days, active, cooldown_until
		FROM students
		WHERE id = ? AND deleted_at IS NULL`, id)
}

// StudentListItem is a student in the students list, with their group and buddy group.
type StudentListItem struct {
	Student
	Group      *StudentGroup `json:"group"`
	BuddyGroup *GroupRef     `json:"buddy_group"`
}

type StudentGroup struct {
	ID    int64  `db:"id" json:"id"`
	Name  string `db:"name" json:"name"`
	Color string `db:"color" json:"color"`
}

// StudentInvitation is an upcoming invitation of a student.
type StudentInvitation struct {
	ID          int64  `db:"id" json:"id"`
	Status      string `db:"status" json:"status"`
	SessionDate string `db:"session_date" json:"session_date"`
	StartTime   string `db:"start_time" json:"start_time"`
}

// InvitationHistoryEntry is any past or upcoming invitation of a student.
type InvitationHistoryEntry struct {
	ID             int64   `db:"id" json:"id"`
	Status         string  `db:"status" json:"status"`
	InvitedAt      string  `db:"invited_at" json:"invited_at"`
	RespondedAt    *string `db:"responded_at" json:"responded_at"`
	SessionDate    string  `db:"session_date" json:"session_date"`
	StartTime      string  `db:"start_time" json:"start_time"`
	DisciplineName *string `db:"discipline_name" json:"discipline_name"`
	GroupName      *string `db:"group_name" json:"group_name"`
	GroupColor     *string `db:"group_color" json:"group_color"`
}

// StudentRef identifies a student in search results.
type StudentRef struct {
	ID        int64  `db:"id" json:"id"`
	FirstName string `db:"first_name" json:"first_name"`
	LastName  string `db:"last_name" json:"last_name"`
	Email     string `db:"email" json:"email"`
}

// StudentSearchResult is a student found when adding members to a group.
type StudentSearchResult struct {
	StudentRef
	CurrentGroupName *string `db:"current_group_name" json:"current_group_name"`
}

func (s *Server) studentRoutes() {
	s.adminRoute("GET /api/students", s.handleListStudents)

	s.adminRoute("GET /api/students/export", func(w http.ResponseWriter, r *http.Request) error {
		students, err := s.listStudents()
		if err != nil {
			return err
		}
		lines := make([]string, len(students))
		for i, st := range students {
			lines[i] = csvRow(st.FirstName, st.LastName, st.Email, st.MembershipID,
				st.AttendedSessions, st.NoShowCount, st.PreferredDays, st.Active)
		}
		writeCSV(w, "students.csv", "first_name,last_name,email,membership_id,attended_sessions,no_show_count,preferred_days,active", lines)
		return nil
	})

	s.adminRoute("POST /api/students/import", s.handleImportStudents)

	s.adminRoute("GET /api/students/{id}", func(w http.ResponseWriter, r *http.Request) error {
		row, found, err := s.getStudent(r.PathValue("id"))
		if err != nil {
			return err
		}
		if !found {
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
		invitations, err := db.Many[StudentInvitation](s.db, `
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
		httpx.OK(w, invitations)
		return nil
	})

	s.adminRoute("GET /api/students/{id}/invitation-history", func(w http.ResponseWriter, r *http.Request) error {
		if !s.requireStudent(w, r) {
			return nil
		}
		invitations, err := db.Many[InvitationHistoryEntry](s.db, `
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
		httpx.OK(w, invitations)
		return nil
	})

	s.adminRoute("POST /api/students", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			FirstName     string `json:"first_name"`
			LastName      string `json:"last_name"`
			Email         string `json:"email"`
			MembershipID  string `json:"membership_id"`
			PreferredDays string `json:"preferred_days"` // "" for the column default (every day)
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.FirstName == "" || in.LastName == "" || in.Email == "" {
			httpx.Error(w, http.StatusBadRequest, "First name, last name and email are required")
			return nil
		}
		cols := []string{"first_name", "last_name", "email", "membership_id"}
		vals := []any{in.FirstName, in.LastName, in.Email, in.MembershipID}
		if in.PreferredDays != "" {
			cols, vals = append(cols, "preferred_days"), append(vals, in.PreferredDays)
		}
		res, err := s.db.Exec("INSERT INTO students ("+strings.Join(cols, ", ")+") VALUES ("+placeholders(len(cols))+")", vals...)
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
		row, _, err := s.getStudent(studentID)
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/students/{id}", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			FirstName        *string `json:"first_name"`
			LastName         *string `json:"last_name"`
			Email            *string `json:"email"`
			MembershipID     *string `json:"membership_id"`
			AttendedSessions *int64  `json:"attended_sessions"`
			Active           *int64  `json:"active"`
			PreferredDays    *string `json:"preferred_days"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		id := r.PathValue("id")
		student, found, err := s.getStudent(id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Student not found")
			return nil
		}
		err = s.db.InTx(func(tx *sqlx.Tx) error {
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
				in.FirstName, in.LastName, in.Email, in.MembershipID,
				in.AttendedSessions, in.Active, in.PreferredDays, id); err != nil {
				return err
			}
			// Reactivation (active: 1 over a stored 0) moves the queue position.
			if in.Active != nil && *in.Active == 1 && student.Active == 0 {
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
		row, _, err := s.getStudent(id)
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
		// Open invitations for sessions that haven't taken place are admin-cancelled, as if
		// the admin cancelled each one; completed sessions are history and stay as they are.
		open, err := s.findInvitations(`
			WHERE inv.student_id = ? AND inv.status IN ('scheduled', 'invited', 'confirmed') AND ts.status != 'completed'`, id)
		if err != nil {
			return err
		}
		var sessions []int64
		for _, inv := range open {
			if err := s.adminCancelInvitation(inv); err != nil {
				return err
			}
			if sid := inv.SessionID; !slices.Contains(sessions, sid) {
				sessions = append(sessions, sid)
			}
		}
		// Soft-delete: mark as deleted and deactivate.
		if _, err := s.db.Exec("UPDATE students SET deleted_at = datetime('now'), active = 0 WHERE id = ?", id); err != nil {
			return err
		}
		for _, sid := range sessions {
			s.hub.BroadcastSession(sid, "reload", map[string]any{})
			s.broadcastSessionCounts(sid)
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("GET /api/students/{id}/preferred-timeslots", func(w http.ResponseWriter, r *http.Request) error {
		if !s.requireStudent(w, r) {
			return nil
		}
		type preference struct {
			TimetableID int64 `db:"timetable_id"`
			TimeslotID  int64 `db:"timeslot_id"`
		}
		preferences, err := db.Many[preference](s.db, "SELECT timetable_id, timeslot_id FROM student_preferred_timeslots WHERE student_id = ?", r.PathValue("id"))
		if err != nil {
			return err
		}
		// Timeslot ids by timetable id; timetables without preferences are absent (= all timeslots).
		byTimetable := map[int64][]int64{}
		for _, p := range preferences {
			byTimetable[p.TimetableID] = append(byTimetable[p.TimetableID], p.TimeslotID)
		}
		httpx.OK(w, byTimetable)
		return nil
	})

	s.adminRoute("PUT /api/students/{id}/preferred-timeslots/{timetableId}", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			TimeslotIDs []int64 `json:"timeslot_ids"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.TimeslotIDs == nil {
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
		all, err := db.Many[int64](s.db, "SELECT id FROM timeslots WHERE timetable_id = ?", timetableID)
		if err != nil {
			return err
		}
		allIDs := make(map[int64]bool, len(all))
		for _, id := range all {
			allIDs[id] = true
		}
		// Keep only ids of this timetable's timeslots, once each, in the order sent.
		var selected []int64
		seen := map[int64]bool{}
		for _, tsID := range in.TimeslotIDs {
			if allIDs[tsID] && !seen[tsID] {
				seen[tsID] = true
				selected = append(selected, tsID)
			}
		}
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			if _, err := tx.Exec("DELETE FROM student_preferred_timeslots WHERE student_id = ? AND timetable_id = ?", id, timetableID); err != nil {
				return err
			}
			// Selecting every timeslot is stored as no preference (= all).
			if len(selected) >= len(allIDs) {
				return nil
			}
			for _, tsID := range selected {
				if _, err := tx.Exec("INSERT INTO student_preferred_timeslots (student_id, timeslot_id, timetable_id) VALUES (?, ?, ?)", id, tsID, timetableID); err != nil {
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
		type studentGroup struct {
			ID        int64  `db:"id" json:"id"`
			Name      string `db:"name" json:"name"`
			IsDefault int64  `db:"is_default" json:"is_default"`
		}
		g, found, err := db.One[studentGroup](s.db, `
			SELECT g.id, g.name, g.is_default FROM groups g
			JOIN student_groups sg ON sg.group_id = g.id
			WHERE sg.student_id = ?`, r.PathValue("id"))
		if err != nil {
			return err
		}
		if !found {
			httpx.OK(w, nil) // null when the student has no group
			return nil
		}
		httpx.OK(w, g)
		return nil
	})

	s.adminRoute("PUT /api/students/{id}/groups", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			GroupID int64 `json:"group_id"` // 0 or null: no group
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if !s.requireStudent(w, r) {
			return nil
		}
		id := r.PathValue("id")
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			if _, err := tx.Exec("DELETE FROM student_groups WHERE student_id = ?", id); err != nil {
				return err
			}
			if in.GroupID != 0 {
				_, err := tx.Exec("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))", id, in.GroupID)
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
		type request struct {
			Days float64 `json:"days"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		days := in.Days
		if days <= 0 {
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
		row, _, err := s.getStudent(id)
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
		row, _, err := s.getStudent(id)
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
	students, err := s.listStudents()
	if err != nil {
		return err
	}
	type membership struct {
		StudentID int64 `db:"student_id"`
		StudentGroup
	}
	memberships, err := db.Many[membership](s.db, `
		SELECT sg.student_id, g.id, g.name, g.color
		FROM student_groups sg
		JOIN groups g ON g.id = sg.group_id`)
	if err != nil {
		return err
	}
	groupByStudent := map[int64]StudentGroup{}
	for _, m := range memberships {
		groupByStudent[m.StudentID] = m.StudentGroup
	}

	type buddyMembership struct {
		StudentID    int64 `db:"student_id"`
		BuddyGroupID int64 `db:"buddy_group_id"`
	}
	buddyMemberships, err := db.Many[buddyMembership](s.db, "SELECT student_id, buddy_group_id FROM buddy_group_members")
	if err != nil {
		return err
	}
	firstNameByID := make(map[int64]string, len(students))
	for _, st := range students {
		firstNameByID[st.ID] = st.FirstName
	}
	// Buddy group names are the listed (non-deleted) members' first names.
	namesByBuddyGroup := map[int64][]string{}
	for _, m := range buddyMemberships {
		if name, ok := firstNameByID[m.StudentID]; ok {
			namesByBuddyGroup[m.BuddyGroupID] = append(namesByBuddyGroup[m.BuddyGroupID], name)
		}
	}
	buddyByStudent := map[int64]GroupRef{}
	for _, m := range buddyMemberships {
		buddyByStudent[m.StudentID] = GroupRef{ID: m.BuddyGroupID, Name: strings.Join(namesByBuddyGroup[m.BuddyGroupID], " & ")}
	}

	out := make([]StudentListItem, len(students))
	for i, st := range students {
		out[i].Student = st
		if g, ok := groupByStudent[st.ID]; ok {
			out[i].Group = &g
		}
		if bg, ok := buddyByStudent[st.ID]; ok {
			out[i].BuddyGroup = &bg
		}
	}
	httpx.OK(w, out)
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
	err := s.db.InTx(func(tx *sqlx.Tx) error {
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
func importStudentRow(tx *sqlx.Tx, first, last, email, membershipID string, cols []string, vals []any, defaultGroup int64) error {
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
