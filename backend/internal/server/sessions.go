package server

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

// Session routes (schedule generation lives in schedule.go).
func (s *Server) sessionRoutes() {
	s.adminRoute("GET /api/sessions", func(w http.ResponseWriter, r *http.Request) error {
		rows, err := db.All(s.db, `
			SELECT ts.*,
				(SELECT COUNT(*) FROM session_slots WHERE session_id = ts.id AND removed = 0) AS instructor_count,
				(SELECT COUNT(*) FROM invitations WHERE session_id = ts.id) AS invitation_count,
				(SELECT COUNT(*) FROM invitations WHERE session_id = ts.id AND status = 'confirmed') AS confirmed_count,
				(SELECT COUNT(*) FROM session_slots WHERE session_id = ts.id AND removed = 0) *
					(SELECT COUNT(*) FROM timeslots WHERE timetable_id = ts.timetable_id) AS total_slots,
				tt.name AS timetable_name
			FROM training_sessions ts
			LEFT JOIN timetables tt ON tt.id = ts.timetable_id
			ORDER BY ts.date DESC`)
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
		return nil
	})

	s.adminRoute("GET /api/sessions/{id}", s.handleGetSession)

	s.adminRoute("POST /api/sessions", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		if !truthy(b["date"]) {
			httpx.Error(w, http.StatusBadRequest, "Date is required")
			return nil
		}
		ttID := arg(b["timetable_id"])
		if !truthy(b["timetable_id"]) {
			ttID = nil
			var id int64
			if s.db.QueryRow("SELECT id FROM timetables WHERE is_default = 1 AND active = 1 AND status = 'saved'").Scan(&id) == nil && id != 0 {
				ttID = id
			}
		}
		date := jsString(b["date"])
		dow, valid := dayOfWeek(date)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "Invalid date")
			return nil
		}
		var notes any
		if truthy(b["notes"]) {
			notes = arg(b["notes"])
		}
		res, err := s.db.Exec("INSERT INTO training_sessions (date, day_of_week, notes, timetable_id) VALUES (?, ?, ?, ?)", arg(b["date"]), dow, notes, ttID)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A training session already exists for this date")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM training_sessions WHERE id = ?", lastID(res))
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) error {
		b, ok := decodeBody(w, r)
		if !ok {
			return nil
		}
		session, ok, err := s.loadSession(w, r)
		if !ok || err != nil {
			return err
		}
		id := r.PathValue("id")
		var dow any
		if date := b["date"]; date != nil {
			d, valid := dayOfWeek(jsString(date))
			if !valid {
				httpx.Error(w, http.StatusBadRequest, "Invalid date")
				return nil
			}
			dow = d
		}
		if tt, present := b["timetable_id"]; present && !jsStrictEqual(tt, session["timetable_id"]) {
			switch session["status"] {
			case "invitations_sent", "completed":
				httpx.Error(w, http.StatusBadRequest, "Cannot change timetable after invitations have been sent")
				return nil
			case "scheduled":
				// Changing the timetable clears the schedule.
				if _, err := s.db.Exec("DELETE FROM invitations WHERE session_id = ?", id); err != nil {
					return err
				}
				if _, err := s.db.Exec("UPDATE training_sessions SET status = 'draft' WHERE id = ?", id); err != nil {
					return err
				}
			}
		}
		_, err = s.db.Exec(`
			UPDATE training_sessions SET
				date = COALESCE(?, date),
				day_of_week = COALESCE(?, day_of_week),
				notes = COALESCE(?, notes),
				status = COALESCE(?, status),
				timetable_id = COALESCE(?, timetable_id)
			WHERE id = ?`,
			arg(b["date"]), dow, arg(b["notes"]), arg(b["status"]), arg(b["timetable_id"]), id)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A training session already exists for this date")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := db.Get(s.db, "SELECT * FROM training_sessions WHERE id = ?", id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) error {
		res, err := s.db.Exec("DELETE FROM training_sessions WHERE id = ?", r.PathValue("id"))
		if err != nil {
			return err
		}
		if changes(res) == 0 {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/instructors", s.handleAssignInstructor)
	s.adminRoute("DELETE /api/sessions/{id}/instructors/{instructorId}", s.handleRemoveInstructor)
	s.adminRoute("POST /api/sessions/{id}/instructors/{instructorId}/replace", s.handleReplaceInstructor)
	s.adminRoute("POST /api/sessions/{id}/generate-schedule", s.handleGenerateSchedule)
	s.adminRoute("POST /api/sessions/{id}/send-invitations", s.handleSendInvitations)

	s.adminRoute("POST /api/sessions/{id}/invitations/{invitationId}/toggle-no-show", func(w http.ResponseWriter, r *http.Request) error {
		session, ok, err := s.loadSession(w, r)
		if !ok || err != nil {
			return err
		}
		if session["status"] == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Session already completed")
			return nil
		}
		inv, err := db.Get(s.db, "SELECT * FROM invitations WHERE id = ? AND session_id = ?", r.PathValue("invitationId"), r.PathValue("id"))
		if err != nil {
			return err
		}
		if inv == nil {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}
		if inv["status"] != "confirmed" {
			httpx.Error(w, http.StatusBadRequest, "Only confirmed invitations can be toggled")
			return nil
		}
		newValue := int64(1)
		if truthy(inv["no_show"]) {
			newValue = 0
		}
		if _, err := s.db.Exec("UPDATE invitations SET no_show = ? WHERE id = ?", newValue, inv["id"]); err != nil {
			return err
		}
		s.hub.BroadcastSession(toInt64(session["id"]), "invitation_updated", map[string]any{"id": inv["id"], "no_show": newValue})
		httpx.OK(w, map[string]any{"success": true, "no_show": newValue})
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/complete", func(w http.ResponseWriter, r *http.Request) error {
		session, ok, err := s.loadSession(w, r)
		if !ok || err != nil {
			return err
		}
		if session["status"] == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Session already completed")
			return nil
		}
		id := r.PathValue("id")
		confirmed, err := db.All(s.db, "SELECT student_id, no_show FROM invitations WHERE session_id = ? AND status = 'confirmed'", id)
		if err != nil {
			return err
		}
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		for _, c := range confirmed {
			column := "attended_sessions"
			if truthy(c["no_show"]) {
				column = "no_show_count"
			}
			if _, err := tx.Exec("UPDATE students SET "+column+" = "+column+" + 1 WHERE id = ?", c["student_id"]); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("UPDATE training_sessions SET status = 'completed' WHERE id = ?", id); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		s.hub.BroadcastSession(toInt64(session["id"]), "session_updated", map[string]any{"status": "completed"})
		httpx.OK(w, map[string]any{"success": true, "students_credited": len(confirmed)})
		return nil
	})

	s.adminRoute("GET /api/sessions/{id}/available-students", func(w http.ResponseWriter, r *http.Request) error {
		if _, ok, err := s.loadSession(w, r); !ok || err != nil {
			return err
		}
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if len(utf16.Encode([]rune(q))) < 2 {
			httpx.OK(w, []any{})
			return nil
		}
		active, err := db.All(s.db, "SELECT student_id FROM invitations WHERE session_id = ? AND status NOT IN "+terminalStatuses, r.PathValue("id"))
		if err != nil {
			return err
		}
		exclude := ""
		like := "%" + q + "%"
		a := []any{like, like}
		if len(active) > 0 {
			exclude = "AND s.id NOT IN (" + placeholders(len(active)) + ")"
			for _, row := range active {
				a = append(a, row["student_id"])
			}
		}
		rows, err := db.All(s.db, `
			SELECT s.id, s.first_name, s.last_name, s.email
			FROM students s
			WHERE s.active = 1
				AND s.deleted_at IS NULL
				AND (s.first_name || ' ' || s.last_name LIKE ? OR s.email LIKE ?)
				`+exclude+`
			ORDER BY s.last_name ASC, s.first_name ASC
			LIMIT 15`, a...)
		if err != nil {
			return err
		}
		httpx.OK(w, rows)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/invitations", s.handleAddInvitation)

	s.adminRoute("DELETE /api/sessions/{id}/invitations/{invitationId}", func(w http.ResponseWriter, r *http.Request) error {
		session, ok, err := s.loadSession(w, r)
		if !ok || err != nil {
			return err
		}
		if st := session["status"]; st != "draft" && st != "scheduled" {
			httpx.Error(w, http.StatusBadRequest, "Can only remove students before invitations are sent")
			return nil
		}
		id, invID := r.PathValue("id"), r.PathValue("invitationId")
		if !s.exists("SELECT 1 FROM invitations WHERE id = ? AND session_id = ?", invID, id) {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM invitations WHERE id = ? AND session_id = ?", invID, id); err != nil {
			return err
		}
		// With no invitations left the session reverts to draft.
		if !s.exists("SELECT 1 FROM invitations WHERE session_id = ?", id) {
			if _, err := s.db.Exec("UPDATE training_sessions SET status = 'draft' WHERE id = ?", id); err != nil {
				return err
			}
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/invitations/{invitationId}/admin-cancel", s.handleAdminCancelInvitation)
	s.adminRoute("POST /api/sessions/{id}/auto-schedule-slot", s.handleAutoScheduleSlot)
	s.adminRoute("POST /api/sessions/{id}/cancel", s.handleCancelSession)

	s.adminRoute("POST /api/sessions/{id}/reactivate", func(w http.ResponseWriter, r *http.Request) error {
		session, ok, err := s.loadSession(w, r)
		if !ok || err != nil {
			return err
		}
		if session["status"] != "cancelled" {
			httpx.Error(w, http.StatusBadRequest, "Only cancelled sessions can be reactivated")
			return nil
		}
		id := r.PathValue("id")
		if err := s.cancelAllSessionTimers(id); err != nil {
			return err
		}
		if _, err := s.db.Exec("DELETE FROM invitations WHERE session_id = ?", id); err != nil {
			return err
		}
		if _, err := s.db.Exec("UPDATE training_sessions SET status = 'draft' WHERE id = ?", id); err != nil {
			return err
		}
		httpx.OK(w, map[string]any{"success": true, "new_status": "draft"})
		sessionID := toInt64(session["id"])
		s.hub.BroadcastSession(sessionID, "reload", map[string]any{})
		s.broadcastSessionCounts(sessionID)
		return nil
	})
}

// loadSession fetches the training session named by the {id} path value, writing a 404
// if it does not exist. ok is false when the handler should stop.
func (s *Server) loadSession(w http.ResponseWriter, r *http.Request) (map[string]any, bool, error) {
	session, err := db.Get(s.db, "SELECT * FROM training_sessions WHERE id = ?", r.PathValue("id"))
	if err != nil {
		return nil, false, err
	}
	if session == nil {
		httpx.Error(w, http.StatusNotFound, "Training session not found")
		return nil, false, nil
	}
	return session, true, nil
}

// jsStrictEqual is === for JSON/SQLite scalars.
func jsStrictEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	an, aNum := asNumber(a)
	bn, bNum := asNumber(b)
	if aNum || bNum {
		return aNum && bNum && an == bn
	}
	return a == b
}

func asNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int64:
		return float64(x), true
	}
	return 0, false
}

// jsNumber mimics Number(v) for request values; NaN for anything unparsable.
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case nil:
		return 0
	case string:
		t := strings.TrimSpace(x)
		if t == "" {
			return 0
		}
		if n, err := strconv.ParseFloat(t, 64); err == nil {
			return n
		}
	}
	return math.NaN()
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	id := r.PathValue("id")
	instructors, err := db.All(s.db, `
		SELECT i.* FROM instructors i
		JOIN session_slots si ON si.instructor_id = i.id
		WHERE si.session_id = ? AND si.removed = 0
		ORDER BY i.last_name ASC, i.first_name ASC`, id)
	if err != nil {
		return err
	}

	timeslots, timetableGroups := []map[string]any{}, []map[string]any{}
	var timetable any
	if ttID := session["timetable_id"]; truthy(ttID) {
		if t, err := db.Get(s.db, "SELECT * FROM timetables WHERE id = ?", ttID); err != nil {
			return err
		} else if t != nil {
			timetable = t
		}
		if timeslots, err = db.All(s.db, "SELECT * FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC", ttID); err != nil {
			return err
		}
		if timetableGroups, err = db.All(s.db, `
			SELECT tg.group_id, tg.percentage, g.name AS group_name, g.color AS group_color, g.is_default
			FROM timetable_groups tg
			JOIN groups g ON g.id = tg.group_id
			WHERE tg.timetable_id = ?
			ORDER BY tg.position ASC`, ttID); err != nil {
			return err
		}
	}

	invitations, err := db.All(s.db, `
		SELECT inv.*, inv.no_show, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email, s.membership_id AS student_membership_id, s.attended_sessions,
			d.name AS discipline_name, d.abbreviation AS discipline_abbreviation, ts.start_time AS timeslot_start_time,
			ss.instructor_id AS instructor_id, i.first_name || ' ' || i.last_name AS instructor_name,
			g.name AS group_name, g.color AS group_color,
			bgm.buddy_group_id AS buddy_group_id
		FROM invitations inv
		JOIN students s ON s.id = inv.student_id
		JOIN timeslots ts ON ts.id = inv.timeslot_id
		JOIN session_slots ss ON ss.id = inv.slot_id
		JOIN instructors i ON i.id = ss.instructor_id
		LEFT JOIN disciplines d ON d.id = inv.discipline_id
		LEFT JOIN groups g ON g.id = inv.group_id
		LEFT JOIN buddy_group_members bgm ON bgm.student_id = inv.student_id
		WHERE inv.session_id = ?
		ORDER BY ts.start_time ASC, i.last_name ASC, i.first_name ASC, inv.id ASC`, id)
	if err != nil {
		return err
	}

	// Buddy group names are built from the members' first names.
	buddyNames := map[int64]string{}
	for _, inv := range invitations {
		if !truthy(inv["buddy_group_id"]) {
			continue
		}
		bg := toInt64(inv["buddy_group_id"])
		if _, done := buddyNames[bg]; done {
			continue
		}
		members, err := db.All(s.db, "SELECT s.first_name FROM students s JOIN buddy_group_members bgm ON bgm.student_id = s.id WHERE bgm.buddy_group_id = ? AND s.deleted_at IS NULL", bg)
		if err != nil {
			return err
		}
		names := make([]string, len(members))
		for i, m := range members {
			names[i] = str(m, "first_name")
		}
		buddyNames[bg] = strings.Join(names, " & ")
	}

	minutes, loc := s.expiryMinutes(), s.clubLocation()
	now := nowFunc()
	sessionDate := str(session, "date")
	for _, inv := range invitations {
		inv["buddy_group_name"] = nil
		if truthy(inv["buddy_group_id"]) {
			inv["buddy_group_name"] = orNull(buddyNames[toInt64(inv["buddy_group_id"])])
		}
		timing := timingOf(inv, "")
		timing.SessionDate = sessionDate
		status := effectiveStatus(timing, minutes, loc, now)
		inv["status"] = status
		// Like GET /api/invitations/{token}: a deadline only while the invitation is still open.
		inv["expires_at"] = nil
		if status == "invited" {
			inv["expires_at"] = expiresAtISO(timing, minutes, loc)
		}
	}

	session["instructors"] = instructors
	session["timeslots"] = timeslots
	session["invitations"] = invitations
	session["timetable"] = timetable
	session["timetableGroups"] = timetableGroups
	session["invitation_expiry_minutes"] = jsonMinutes(minutes)
	httpx.OK(w, session)
	return nil
}

func (s *Server) handleAssignInstructor(w http.ResponseWriter, r *http.Request) error {
	b, ok := decodeBody(w, r)
	if !ok {
		return nil
	}
	instructorID := b["instructor_id"]
	if !truthy(instructorID) {
		httpx.Error(w, http.StatusBadRequest, "instructor_id is required")
		return nil
	}
	if _, ok, err := s.loadSession(w, r); !ok || err != nil {
		return err
	}
	id := r.PathValue("id")
	// Re-assigning a removed instructor revives their slot (and its invitation history).
	var removedSlot int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 1", id, arg(instructorID)).Scan(&removedSlot) == nil {
		if _, err := s.db.Exec("UPDATE session_slots SET removed = 0 WHERE id = ?", removedSlot); err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, map[string]bool{"success": true})
		return nil
	}
	_, err := s.db.Exec("INSERT INTO session_slots (session_id, instructor_id) VALUES (?, ?)", id, arg(instructorID))
	switch {
	case isUniqueErr(err):
		httpx.Error(w, http.StatusConflict, "Instructor already assigned to this session")
	case err != nil && strings.Contains(err.Error(), "FOREIGN KEY"):
		httpx.Error(w, http.StatusBadRequest, "Invalid instructor")
	case err != nil:
		return err
	default:
		httpx.JSON(w, http.StatusCreated, map[string]bool{"success": true})
	}
	return nil
}

func (s *Server) handleRemoveInstructor(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	if session["status"] == "completed" {
		httpx.Error(w, http.StatusBadRequest, "Cannot modify a completed session")
		return nil
	}
	var slotID int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", r.PathValue("id"), r.PathValue("instructorId")).Scan(&slotID) != nil {
		httpx.Error(w, http.StatusNotFound, "Assignment not found")
		return nil
	}
	cancelled, err := s.removeSlot(toInt64(session["id"]), slotID)
	if err != nil {
		return err
	}
	httpx.OK(w, map[string]any{"success": true, "cancelled": cancelled})
	return nil
}

// cancelInvitationSQL selects an invitation with the columns adminCancelInvitation needs.
const cancelInvitationSQL = `
	SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
		tslot.start_time AS timeslot_start_time, d.name AS discipline_name, ts.date AS session_date
	FROM invitations inv
	JOIN students s ON s.id = inv.student_id
	JOIN timeslots tslot ON tslot.id = inv.timeslot_id
	JOIN training_sessions ts ON ts.id = inv.session_id
	LEFT JOIN disciplines d ON d.id = inv.discipline_id`

// adminCancelInvitation cancels an invitation on the admin's behalf: its expiry timer stops,
// the student's invitation page updates and, if the invitation was emailed, the student is
// told. inv is a row selected with cancelInvitationSQL. Session-wide broadcasts are left to
// the caller, which may cancel several invitations at once.
func (s *Server) adminCancelInvitation(inv map[string]any) error {
	if _, err := s.db.Exec("UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE id = ?", inv["id"]); err != nil {
		return err
	}
	s.cancelInvitationExpiry(toInt64(inv["id"]))
	s.broadcastInvitation(str(inv, "token"), "admin_cancelled")
	if truthy(inv["email_sent"]) {
		s.mailer.SendAdminCancellation(email.SessionParams{
			To: str(inv, "student_email"), StudentName: str(inv, "student_name"), Date: str(inv, "session_date"),
			StartTime: str(inv, "timeslot_start_time"), DisciplineName: str(inv, "discipline_name"),
			ClubName: s.clubName(), Locale: s.emailLocale(),
		})
	}
	return nil
}

// removeSlot takes an instructor's slot out of a session: active invitations on it are
// admin-cancelled, unsent ones deleted, and older ones kept as history. It returns the number
// of cancelled invitations.
func (s *Server) removeSlot(sessionID int64, slotID int64) (int, error) {
	affected, err := db.All(s.db, cancelInvitationSQL+" WHERE inv.slot_id = ?", slotID)
	if err != nil {
		return 0, err
	}
	cancelled := 0
	for _, inv := range affected {
		switch inv["status"] {
		case "invited", "confirmed":
			cancelled++
			if err := s.adminCancelInvitation(inv); err != nil {
				return 0, err
			}
		case "scheduled":
			// Not sent yet: just delete.
			if _, err := s.db.Exec("DELETE FROM invitations WHERE id = ?", inv["id"]); err != nil {
				return 0, err
			}
		}
		// Other statuses are history and stay linked to the slot.
	}
	if _, err := s.db.Exec("UPDATE session_slots SET removed = 1 WHERE id = ?", slotID); err != nil {
		return 0, err
	}
	s.hub.BroadcastSession(sessionID, "reload", map[string]any{})
	s.broadcastSessionCounts(sessionID)
	return cancelled, nil
}

func (s *Server) handleReplaceInstructor(w http.ResponseWriter, r *http.Request) error {
	b, ok := decodeBody(w, r)
	if !ok {
		return nil
	}
	if !truthy(b["new_instructor_id"]) {
		httpx.Error(w, http.StatusBadRequest, "new_instructor_id is required")
		return nil
	}
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	if session["status"] == "completed" {
		httpx.Error(w, http.StatusBadRequest, "Cannot modify a completed session")
		return nil
	}
	id := r.PathValue("id")
	oldID, newID := jsNumber(r.PathValue("instructorId")), jsNumber(b["new_instructor_id"])
	if oldID == newID { // NaN never equals, as in JS
		httpx.Error(w, http.StatusBadRequest, "New instructor must be different")
		return nil
	}
	var oldSlot int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, arg(oldID)).Scan(&oldSlot) != nil {
		httpx.Error(w, http.StatusNotFound, "Original instructor not assigned to this session")
		return nil
	}
	if !s.exists("SELECT 1 FROM instructors WHERE id = ? AND deleted_at IS NULL", arg(newID)) {
		httpx.Error(w, http.StatusBadRequest, "New instructor not found")
		return nil
	}
	if s.exists("SELECT 1 FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, arg(newID)) {
		httpx.Error(w, http.StatusConflict, "New instructor is already assigned to this session")
		return nil
	}
	// A removed slot of the new instructor is merged into the old slot.
	var removedSlot int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 1", id, arg(newID)).Scan(&removedSlot) == nil {
		if _, err := s.db.Exec("UPDATE invitations SET slot_id = ? WHERE slot_id = ?", oldSlot, removedSlot); err != nil {
			return err
		}
		if _, err := s.db.Exec("DELETE FROM session_slots WHERE id = ?", removedSlot); err != nil {
			return err
		}
	}
	// Re-pointing the slot moves all its invitations to the new instructor.
	if _, err := s.db.Exec("UPDATE session_slots SET instructor_id = ? WHERE id = ?", arg(newID), oldSlot); err != nil {
		return err
	}
	httpx.Success(w)
	s.hub.BroadcastSession(toInt64(session["id"]), "reload", map[string]any{})
	return nil
}

func (s *Server) handleSendInvitations(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	id := r.PathValue("id")
	pending, err := db.All(s.db, `
		SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email
		FROM invitations inv
		JOIN students s ON s.id = inv.student_id
		WHERE inv.session_id = ? AND inv.email_sent = 0 AND inv.status = 'scheduled'`, id)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		httpx.OK(w, map[string]any{"message": "No pending invitations to send", "sent": 0})
		return nil
	}
	clubName, locale := s.clubName(), s.emailLocale()
	sent := 0
	errs := []map[string]string{}
	for _, inv := range pending {
		s.mailer.SendInvitation(email.InvitationParams{
			To: str(inv, "student_email"), StudentName: str(inv, "student_name"), Date: str(session, "date"),
			Token: str(inv, "token"), ClubName: clubName, Locale: locale,
		})
		if _, err := s.db.Exec("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE id = ?", inv["id"]); err != nil {
			errs = append(errs, map[string]string{"student": str(inv, "student_name"), "error": err.Error()})
			continue
		}
		s.scheduleExpiryForInvitation(toInt64(inv["id"]))
		sent++
	}
	if sent > 0 {
		if _, err := s.db.Exec("UPDATE training_sessions SET status = 'invitations_sent' WHERE id = ?", id); err != nil {
			return err
		}
	}
	s.hub.BroadcastSession(toInt64(session["id"]), "reload", map[string]any{})
	httpx.OK(w, map[string]any{"sent": sent, "errors": errs})
	return nil
}

func (s *Server) handleAddInvitation(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	status := session["status"]
	if status != "draft" && status != "scheduled" && status != "invitations_sent" {
		httpx.Error(w, http.StatusBadRequest, "Can only add students before session is completed")
		return nil
	}
	b, ok := decodeBody(w, r)
	if !ok {
		return nil
	}
	studentID, timeslotID, instructorID := b["student_id"], b["timeslot_id"], b["instructor_id"]
	if !truthy(studentID) || !truthy(timeslotID) || !truthy(instructorID) {
		httpx.Error(w, http.StatusBadRequest, "student_id, timeslot_id, and instructor_id are required")
		return nil
	}
	id := r.PathValue("id")
	var slotID int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, arg(instructorID)).Scan(&slotID) != nil {
		httpx.Error(w, http.StatusBadRequest, "Instructor is not assigned to this session")
		return nil
	}
	if s.exists("SELECT 1 FROM invitations WHERE session_id = ? AND student_id = ? AND status NOT IN "+terminalStatuses, id, arg(studentID)) {
		httpx.Error(w, http.StatusConflict, "Student already has an active invitation for this session")
		return nil
	}
	if s.exists("SELECT 1 FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status NOT IN "+terminalStatuses, id, arg(timeslotID), slotID) {
		httpx.Error(w, http.StatusConflict, "This slot is already occupied")
		return nil
	}
	token := newToken()
	if _, err := s.db.Exec("INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token) VALUES (?, ?, ?, ?, ?)",
		id, arg(studentID), arg(timeslotID), slotID, token); err != nil {
		return err
	}
	if status == "draft" {
		if _, err := s.db.Exec("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?", id); err != nil {
			return err
		}
	}
	// After invitations went out, a manually added student is invited right away.
	if status == "invitations_sent" {
		var first, last, to string
		if err := s.db.QueryRow("SELECT first_name, last_name, email FROM students WHERE id = ?", arg(studentID)).Scan(&first, &last, &to); err != nil {
			logf("Failed to send invitation email for manually added student: %v", err)
		} else {
			s.mailer.SendInvitation(email.InvitationParams{
				To: to, StudentName: first + " " + last, Date: str(session, "date"), Token: token, ClubName: s.clubName(), Locale: s.emailLocale(),
			})
			if _, err := s.db.Exec("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE token = ?", token); err != nil {
				return err
			}
			var newID int64
			if s.db.QueryRow("SELECT id FROM invitations WHERE token = ?", token).Scan(&newID) == nil {
				s.scheduleExpiryForInvitation(newID)
			}
		}
	}
	httpx.JSON(w, http.StatusCreated, map[string]bool{"success": true})
	sessionID := toInt64(session["id"])
	s.hub.BroadcastSession(sessionID, "reload", map[string]any{})
	s.broadcastSessionCounts(sessionID)
	return nil
}

func (s *Server) handleAdminCancelInvitation(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	if session["status"] == "completed" {
		httpx.Error(w, http.StatusBadRequest, "Session already completed")
		return nil
	}
	inv, err := db.Get(s.db, cancelInvitationSQL+" WHERE inv.id = ? AND inv.session_id = ?", r.PathValue("invitationId"), r.PathValue("id"))
	if err != nil {
		return err
	}
	if inv == nil {
		httpx.Error(w, http.StatusNotFound, "Invitation not found")
		return nil
	}
	switch st := str(inv, "status"); st {
	case "declined", "expired", "invalidated", "cancelled", "admin_cancelled":
		httpx.Error(w, http.StatusBadRequest, "Cannot cancel — invitation is already "+st)
		return nil
	}
	invID, sessionID := toInt64(inv["id"]), toInt64(session["id"])
	if err := s.adminCancelInvitation(inv); err != nil {
		return err
	}
	s.hub.BroadcastSession(sessionID, "invitation_updated", map[string]any{"id": invID, "status": "admin_cancelled"})
	s.broadcastSessionCounts(sessionID)
	httpx.Success(w)
	return nil
}

func (s *Server) handleAutoScheduleSlot(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	if session["status"] != "invitations_sent" {
		httpx.Error(w, http.StatusBadRequest, "Auto-scheduling is only available after invitations are sent")
		return nil
	}
	b, ok := decodeBody(w, r)
	if !ok {
		return nil
	}
	timeslotID, instructorID := b["timeslot_id"], b["instructor_id"]
	if !truthy(timeslotID) || !truthy(instructorID) {
		httpx.Error(w, http.StatusBadRequest, "timeslot_id and instructor_id are required")
		return nil
	}
	id := r.PathValue("id")
	var slotID int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, arg(instructorID)).Scan(&slotID) != nil {
		httpx.Error(w, http.StatusBadRequest, "Instructor is not assigned to this session")
		return nil
	}
	if s.exists("SELECT 1 FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status NOT IN "+terminalStatuses, id, arg(timeslotID), slotID) {
		httpx.Error(w, http.StatusConflict, "This slot is already occupied")
		return nil
	}
	// Keep the group of the most recent vacated invitation for this spot.
	var lastGroup any
	s.db.QueryRow("SELECT group_id FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status IN "+terminalStatuses+" ORDER BY responded_at DESC LIMIT 1",
		id, arg(timeslotID), slotID).Scan(&lastGroup)

	replacement, err := s.findAndInviteReplacement(map[string]any{
		"session_id":   session["id"],
		"session_date": session["date"],
		"timeslot_id":  timeslotID,
		"slot_id":      slotID,
		"group_id":     lastGroup,
	})
	if err != nil {
		return err
	}
	httpx.OK(w, map[string]any{"success": true, "replacement": replacement})
	return nil
}

func (s *Server) handleCancelSession(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	switch session["status"] {
	case "completed":
		httpx.Error(w, http.StatusBadRequest, "Cannot cancel a completed session")
		return nil
	case "cancelled":
		httpx.Error(w, http.StatusBadRequest, "Session is already cancelled")
		return nil
	}
	id := r.PathValue("id")
	if err := s.cancelAllSessionTimers(id); err != nil {
		return err
	}
	active, err := db.All(s.db, `
		SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
			d.name AS discipline_name, ts.start_time
		FROM invitations inv
		JOIN students s ON s.id = inv.student_id
		JOIN timeslots ts ON ts.id = inv.timeslot_id
		LEFT JOIN disciplines d ON d.id = inv.discipline_id
		WHERE inv.session_id = ? AND inv.status IN ('invited', 'confirmed')`, id)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec("UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE session_id = ? AND status IN ('scheduled', 'invited', 'confirmed')", id); err != nil {
		return err
	}
	if _, err := s.db.Exec("UPDATE training_sessions SET status = 'cancelled' WHERE id = ?", id); err != nil {
		return err
	}
	if len(active) > 0 {
		clubName, locale := s.clubName(), s.emailLocale()
		for _, inv := range active {
			s.mailer.SendAdminCancellation(email.SessionParams{
				To: str(inv, "student_email"), StudentName: str(inv, "student_name"), Date: str(session, "date"),
				StartTime: str(inv, "start_time"), DisciplineName: str(inv, "discipline_name"), ClubName: clubName, Locale: locale,
			})
		}
	}
	httpx.OK(w, map[string]any{"success": true, "cancelled_invitations": len(active)})
	sessionID := toInt64(session["id"])
	s.hub.BroadcastSession(sessionID, "reload", map[string]any{})
	s.broadcastSessionCounts(sessionID)
	for _, inv := range active {
		s.broadcastInvitation(str(inv, "token"), "admin_cancelled")
	}
	return nil
}
