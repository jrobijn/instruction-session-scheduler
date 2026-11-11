package server

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

type Session struct {
	ID          int64   `db:"id" json:"id"`
	Date        string  `db:"date" json:"date"`     // YYYY-MM-DD
	Status      string  `db:"status" json:"status"` // draft, scheduled, invitations_sent, completed or cancelled
	TimetableID *int64  `db:"timetable_id" json:"timetable_id"`
	Notes       *string `db:"notes" json:"notes"`
}

func (s *Server) getSession(id any) (Session, bool, error) {
	return db.One[Session](s.db, "SELECT id, date, status, timetable_id, notes FROM training_sessions WHERE id = ?", id)
}

// sameTimetable reports whether id (nil for none) is the session's timetable.
func (t Session) sameTimetable(id *int64) bool {
	if id == nil || t.TimetableID == nil {
		return id == nil && t.TimetableID == nil
	}
	return *id == *t.TimetableID
}

type SessionListItem struct {
	Session
	TimetableName   *string `db:"timetable_name" json:"timetable_name"`
	InstructorCount int64   `db:"instructor_count" json:"instructor_count"`
	InvitationCount int64   `db:"invitation_count" json:"invitation_count"`
	ConfirmedCount  int64   `db:"confirmed_count" json:"confirmed_count"`
	TotalSlots      int64   `db:"total_slots" json:"total_slots"` // instructors x timeslots
}

// SessionInvitation is an invitation as listed on the session page.
type SessionInvitation struct {
	ID                     int64   `db:"id" json:"id"`
	StudentID              int64   `db:"student_id" json:"student_id"`
	StudentName            string  `db:"student_name" json:"student_name"`
	StudentEmail           string  `db:"student_email" json:"student_email"`
	StudentMembershipID    string  `db:"student_membership_id" json:"student_membership_id"`
	InstructorID           int64   `db:"instructor_id" json:"instructor_id"`
	InstructorName         string  `db:"instructor_name" json:"instructor_name"`
	DisciplineName         *string `db:"discipline_name" json:"discipline_name"`
	DisciplineAbbreviation *string `db:"discipline_abbreviation" json:"discipline_abbreviation"`
	Status                 string  `db:"status" json:"status"` // effective status, see effectiveStatus
	Token                  string  `db:"token" json:"token"`
	TimeslotID             int64   `db:"timeslot_id" json:"timeslot_id"`
	TimeslotStartTime      string  `db:"timeslot_start_time" json:"timeslot_start_time"`
	NoShow                 int64   `db:"no_show" json:"no_show"`
	GroupName              *string `db:"group_name" json:"group_name"`
	GroupColor             *string `db:"group_color" json:"group_color"`
	InvitedAt              string  `db:"invited_at" json:"invited_at"`
	DecisionLog            *string `db:"decision_log" json:"decision_log"` // JSON, see batchLog and replacementLog
	BuddyGroupID           *int64  `db:"buddy_group_id" json:"buddy_group_id"`

	// Computed in sessionInvitations.
	BuddyGroupName *string `db:"-" json:"buddy_group_name"`
	ExpiresAt      *string `db:"-" json:"expires_at"` // only while the invitation is open
}

// SessionDetail is a session with everything the session page shows.
type SessionDetail struct {
	Session
	Timetable               *Timetable          `json:"timetable"`
	Instructors             []Instructor        `json:"instructors"`
	Timeslots               []Timeslot          `json:"timeslots"`
	TimetableGroups         []TimetableGroup    `json:"timetableGroups"`
	Invitations             []SessionInvitation `json:"invitations"`
	InvitationExpiryMinutes float64             `json:"invitation_expiry_minutes"`
}

// sessionInvitations lists invitations of a session on the given date, selected by where
// (which may add an ORDER BY), with effective statuses and buddy group names filled in.
func (s *Server) sessionInvitations(sessionDate, where string, args ...any) ([]SessionInvitation, error) {
	invitations, err := db.Many[SessionInvitation](s.db, `
		SELECT inv.id, inv.student_id,
			s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email, s.membership_id AS student_membership_id,
			ss.instructor_id, i.first_name || ' ' || i.last_name AS instructor_name,
			d.name AS discipline_name, d.abbreviation AS discipline_abbreviation,
			inv.status, inv.token, inv.timeslot_id, ts.start_time AS timeslot_start_time, inv.no_show,
			g.name AS group_name, g.color AS group_color, inv.invited_at, inv.decision_log, bgm.buddy_group_id
		FROM invitations inv
		JOIN students s ON s.id = inv.student_id
		JOIN timeslots ts ON ts.id = inv.timeslot_id
		JOIN session_slots ss ON ss.id = inv.slot_id
		JOIN instructors i ON i.id = ss.instructor_id
		LEFT JOIN disciplines d ON d.id = inv.discipline_id
		LEFT JOIN groups g ON g.id = inv.group_id
		LEFT JOIN buddy_group_members bgm ON bgm.student_id = inv.student_id
		`+where, args...)
	if err != nil {
		return nil, err
	}

	// Buddy group names are built from the members' first names.
	buddyNames := map[int64]string{}
	for _, inv := range invitations {
		if inv.BuddyGroupID == nil {
			continue
		}
		bg := *inv.BuddyGroupID
		if _, done := buddyNames[bg]; done {
			continue
		}
		names, err := db.Many[string](s.db, "SELECT s.first_name FROM students s JOIN buddy_group_members bgm ON bgm.student_id = s.id WHERE bgm.buddy_group_id = ? AND s.deleted_at IS NULL", bg)
		if err != nil {
			return nil, err
		}
		buddyNames[bg] = strings.Join(names, " & ")
	}

	minutes, loc := s.expiryMinutes(), s.clubLocation()
	now := nowFunc()
	for i := range invitations {
		inv := &invitations[i]
		if inv.BuddyGroupID != nil {
			inv.BuddyGroupName = nonEmpty(buddyNames[*inv.BuddyGroupID])
		}
		timing := invitationTiming{Status: inv.Status, InvitedAt: inv.InvitedAt, SessionDate: sessionDate, StartTime: inv.TimeslotStartTime}
		inv.Status = effectiveStatus(timing, minutes, loc, now)
		// Like GET /api/invitations/{token}: a deadline only while the invitation is still open.
		if inv.Status == "invited" {
			inv.ExpiresAt = expiresAtISO(timing, minutes, loc)
		}
	}
	return invitations, nil
}

// Session routes (schedule generation lives in schedule.go).
func (s *Server) sessionRoutes() {
	s.adminRoute("GET /api/sessions", func(w http.ResponseWriter, r *http.Request) error {
		sessions, err := db.Many[SessionListItem](s.db, `
			SELECT ts.id, ts.date, ts.status, ts.timetable_id, ts.notes,
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
		httpx.OK(w, sessions)
		return nil
	})

	s.adminRoute("GET /api/sessions/{id}", s.handleGetSession)

	s.adminRoute("POST /api/sessions", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Date        string `json:"date"` // YYYY-MM-DD
			Notes       string `json:"notes"`
			TimetableID int64  `json:"timetable_id"` // 0 or null: the default timetable, if any
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.Date == "" {
			httpx.Error(w, http.StatusBadRequest, "Date is required")
			return nil
		}
		var ttID *int64
		if in.TimetableID != 0 {
			ttID = &in.TimetableID
		} else {
			var id int64
			if s.db.QueryRow("SELECT id FROM timetables WHERE is_default = 1 AND active = 1 AND status = 'saved'").Scan(&id) == nil && id != 0 {
				ttID = &id
			}
		}
		dow, valid := dayOfWeek(in.Date)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "Invalid date")
			return nil
		}
		res, err := s.db.Exec("INSERT INTO training_sessions (date, day_of_week, notes, timetable_id) VALUES (?, ?, ?, ?)", in.Date, dow, nonEmpty(in.Notes), ttID)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A training session already exists for this date")
			return nil
		}
		if err != nil {
			return err
		}
		row, _, err := s.getSession(lastID(res))
		if err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Date   *string `json:"date"`
			Notes  *string `json:"notes"`
			Status *string `json:"status"`
			// Missing: unchanged. Null: no timetable. A different timetable (or none) clears
			// the schedule.
			TimetableID optional[int64] `json:"timetable_id"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		session, ok, err := s.loadSession(w, r)
		if !ok || err != nil {
			return err
		}
		id := r.PathValue("id")
		var dow any
		if in.Date != nil {
			d, valid := dayOfWeek(*in.Date)
			if !valid {
				httpx.Error(w, http.StatusBadRequest, "Invalid date")
				return nil
			}
			dow = d
		}
		if in.TimetableID.Set && !session.sameTimetable(in.TimetableID.Value) {
			switch session.Status {
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
				timetable_id = CASE WHEN ? THEN ? ELSE timetable_id END
			WHERE id = ?`,
			in.Date, dow, in.Notes, in.Status, in.TimetableID.Set, in.TimetableID.Value, id)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A training session already exists for this date")
			return nil
		}
		if err != nil {
			return err
		}
		row, _, err := s.getSession(id)
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
		if session.Status == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Session already completed")
			return nil
		}
		type noShowState struct {
			ID     int64  `db:"id"`
			Status string `db:"status"`
			NoShow int64  `db:"no_show"`
		}
		inv, found, err := db.One[noShowState](s.db, "SELECT id, status, no_show FROM invitations WHERE id = ? AND session_id = ?", r.PathValue("invitationId"), r.PathValue("id"))
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}
		if inv.Status != "confirmed" {
			httpx.Error(w, http.StatusBadRequest, "Only confirmed invitations can be toggled")
			return nil
		}
		newValue := int64(1)
		if inv.NoShow != 0 {
			newValue = 0
		}
		if _, err := s.db.Exec("UPDATE invitations SET no_show = ? WHERE id = ?", newValue, inv.ID); err != nil {
			return err
		}
		s.hub.BroadcastSession(session.ID, "invitation_updated", map[string]any{"id": inv.ID, "no_show": newValue})
		httpx.OK(w, map[string]any{"success": true, "no_show": newValue})
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/complete", func(w http.ResponseWriter, r *http.Request) error {
		session, ok, err := s.loadSession(w, r)
		if !ok || err != nil {
			return err
		}
		if session.Status == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Session already completed")
			return nil
		}
		id := r.PathValue("id")
		type attendance struct {
			StudentID int64 `db:"student_id"`
			NoShow    int64 `db:"no_show"`
		}
		confirmed, err := db.Many[attendance](s.db, "SELECT student_id, no_show FROM invitations WHERE session_id = ? AND status = 'confirmed'", id)
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
			if c.NoShow != 0 {
				column = "no_show_count"
			}
			if _, err := tx.Exec("UPDATE students SET "+column+" = "+column+" + 1 WHERE id = ?", c.StudentID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("UPDATE training_sessions SET status = 'completed' WHERE id = ?", id); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		s.hub.BroadcastSession(session.ID, "session_updated", map[string]any{"status": "completed"})
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
		like := "%" + q + "%"
		students, err := db.Many[StudentRef](s.db, `
			SELECT s.id, s.first_name, s.last_name, s.email
			FROM students s
			WHERE s.active = 1
				AND s.deleted_at IS NULL
				AND (s.first_name || ' ' || s.last_name LIKE ? OR s.email LIKE ?)
				AND s.id NOT IN (
					SELECT student_id FROM invitations WHERE session_id = ? AND status NOT IN `+terminalStatuses+`
				)
			ORDER BY s.last_name ASC, s.first_name ASC
			LIMIT 15`, like, like, r.PathValue("id"))
		if err != nil {
			return err
		}
		httpx.OK(w, students)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/invitations", s.handleAddInvitation)

	s.adminRoute("DELETE /api/sessions/{id}/invitations/{invitationId}", func(w http.ResponseWriter, r *http.Request) error {
		session, ok, err := s.loadSession(w, r)
		if !ok || err != nil {
			return err
		}
		if st := session.Status; st != "draft" && st != "scheduled" {
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
		if session.Status != "cancelled" {
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
		sessionID := session.ID
		s.hub.BroadcastSession(sessionID, "reload", map[string]any{})
		s.broadcastSessionCounts(sessionID)
		return nil
	})
}

// loadSession fetches the training session named by the {id} path value, writing a 404
// if it does not exist. ok is false when the handler should stop.
func (s *Server) loadSession(w http.ResponseWriter, r *http.Request) (Session, bool, error) {
	session, found, err := s.getSession(r.PathValue("id"))
	if err != nil || !found {
		if err == nil {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
		}
		return session, false, err
	}
	return session, true, nil
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	detail := SessionDetail{Session: session, Timeslots: []Timeslot{}, TimetableGroups: []TimetableGroup{}}
	if detail.Instructors, err = db.Many[Instructor](s.db, `
		SELECT i.id, i.first_name, i.last_name, i.email, i.active FROM instructors i
		JOIN session_slots si ON si.instructor_id = i.id
		WHERE si.session_id = ? AND si.removed = 0
		ORDER BY i.last_name ASC, i.first_name ASC`, session.ID); err != nil {
		return err
	}

	if ttID := session.TimetableID; ttID != nil && *ttID != 0 {
		if t, found, err := s.getTimetable(*ttID); err != nil {
			return err
		} else if found {
			detail.Timetable = &t
		}
		if detail.Timeslots, err = s.timetableTimeslots(*ttID); err != nil {
			return err
		}
		if detail.TimetableGroups, err = s.timetableGroups(*ttID); err != nil {
			return err
		}
	}

	if detail.Invitations, err = s.sessionInvitations(session.Date, `
		WHERE inv.session_id = ?
		ORDER BY ts.start_time ASC, i.last_name ASC, i.first_name ASC, inv.id ASC`, session.ID); err != nil {
		return err
	}
	detail.InvitationExpiryMinutes = s.expiryMinutes()
	httpx.OK(w, detail)
	return nil
}

func (s *Server) handleAssignInstructor(w http.ResponseWriter, r *http.Request) error {
	type request struct {
		InstructorID int64 `json:"instructor_id"`
	}
	in, ok := decode[request](w, r)
	if !ok {
		return nil
	}
	instructorID := in.InstructorID
	if instructorID == 0 {
		httpx.Error(w, http.StatusBadRequest, "instructor_id is required")
		return nil
	}
	if _, ok, err := s.loadSession(w, r); !ok || err != nil {
		return err
	}
	id := r.PathValue("id")
	// Re-assigning a removed instructor revives their slot (and its invitation history).
	var removedSlot int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 1", id, instructorID).Scan(&removedSlot) == nil {
		if _, err := s.db.Exec("UPDATE session_slots SET removed = 0 WHERE id = ?", removedSlot); err != nil {
			return err
		}
		httpx.JSON(w, http.StatusCreated, map[string]bool{"success": true})
		return nil
	}
	_, err := s.db.Exec("INSERT INTO session_slots (session_id, instructor_id) VALUES (?, ?)", id, instructorID)
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
	if session.Status == "completed" {
		httpx.Error(w, http.StatusBadRequest, "Cannot modify a completed session")
		return nil
	}
	var slotID int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", r.PathValue("id"), r.PathValue("instructorId")).Scan(&slotID) != nil {
		httpx.Error(w, http.StatusNotFound, "Assignment not found")
		return nil
	}
	cancelled, err := s.removeSlot(session.ID, slotID)
	if err != nil {
		return err
	}
	httpx.OK(w, map[string]any{"success": true, "cancelled": cancelled})
	return nil
}

// adminCancelInvitation cancels an invitation on the admin's behalf: its expiry timer stops,
// the student's invitation page updates and, if the invitation was emailed, the student is
// told. Session-wide broadcasts are left to the caller, which may cancel several invitations
// at once.
func (s *Server) adminCancelInvitation(inv invitationDetails) error {
	if _, err := s.db.Exec("UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE id = ?", inv.ID); err != nil {
		return err
	}
	s.cancelInvitationExpiry(inv.ID)
	s.broadcastInvitation(inv.Token, "admin_cancelled")
	if inv.EmailSent != 0 {
		s.mailer.SendAdminCancellation(email.SessionParams{
			To: inv.StudentEmail, StudentName: inv.StudentName, Date: inv.SessionDate,
			StartTime: inv.StartTime, DisciplineName: deref(inv.DisciplineName),
			ClubName: s.clubName(), Locale: s.emailLocale(),
		})
	}
	return nil
}

// removeSlot takes an instructor's slot out of a session: active invitations on it are
// admin-cancelled, unsent ones deleted, and older ones kept as history. It returns the number
// of cancelled invitations.
func (s *Server) removeSlot(sessionID int64, slotID int64) (int, error) {
	affected, err := s.findInvitations("WHERE inv.slot_id = ?", slotID)
	if err != nil {
		return 0, err
	}
	cancelled := 0
	for _, inv := range affected {
		switch inv.Status {
		case "invited", "confirmed":
			cancelled++
			if err := s.adminCancelInvitation(inv); err != nil {
				return 0, err
			}
		case "scheduled":
			// Not sent yet: just delete.
			if _, err := s.db.Exec("DELETE FROM invitations WHERE id = ?", inv.ID); err != nil {
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
	type request struct {
		NewInstructorID int64 `json:"new_instructor_id"`
	}
	in, ok := decode[request](w, r)
	if !ok {
		return nil
	}
	newID := in.NewInstructorID
	if newID == 0 {
		httpx.Error(w, http.StatusBadRequest, "new_instructor_id is required")
		return nil
	}
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	if session.Status == "completed" {
		httpx.Error(w, http.StatusBadRequest, "Cannot modify a completed session")
		return nil
	}
	id := r.PathValue("id")
	oldID, parseErr := strconv.ParseInt(r.PathValue("instructorId"), 10, 64)
	if parseErr == nil && oldID == newID {
		httpx.Error(w, http.StatusBadRequest, "New instructor must be different")
		return nil
	}
	var oldSlot int64
	if parseErr != nil || s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, oldID).Scan(&oldSlot) != nil {
		httpx.Error(w, http.StatusNotFound, "Original instructor not assigned to this session")
		return nil
	}
	if !s.exists("SELECT 1 FROM instructors WHERE id = ? AND deleted_at IS NULL", newID) {
		httpx.Error(w, http.StatusBadRequest, "New instructor not found")
		return nil
	}
	if s.exists("SELECT 1 FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, newID) {
		httpx.Error(w, http.StatusConflict, "New instructor is already assigned to this session")
		return nil
	}
	// A removed slot of the new instructor is merged into the old slot.
	var removedSlot int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 1", id, newID).Scan(&removedSlot) == nil {
		if _, err := s.db.Exec("UPDATE invitations SET slot_id = ? WHERE slot_id = ?", oldSlot, removedSlot); err != nil {
			return err
		}
		if _, err := s.db.Exec("DELETE FROM session_slots WHERE id = ?", removedSlot); err != nil {
			return err
		}
	}
	// Re-pointing the slot moves all its invitations to the new instructor.
	if _, err := s.db.Exec("UPDATE session_slots SET instructor_id = ? WHERE id = ?", newID, oldSlot); err != nil {
		return err
	}
	httpx.Success(w)
	s.hub.BroadcastSession(session.ID, "reload", map[string]any{})
	return nil
}

func (s *Server) handleSendInvitations(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	id := r.PathValue("id")
	pending, err := s.findInvitations(`
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
			To: inv.StudentEmail, StudentName: inv.StudentName, Date: session.Date,
			Token: inv.Token, ClubName: clubName, Locale: locale,
		})
		if _, err := s.db.Exec("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE id = ?", inv.ID); err != nil {
			errs = append(errs, map[string]string{"student": inv.StudentName, "error": err.Error()})
			continue
		}
		s.scheduleExpiryForInvitation(inv.ID)
		sent++
	}
	if sent > 0 {
		if _, err := s.db.Exec("UPDATE training_sessions SET status = 'invitations_sent' WHERE id = ?", id); err != nil {
			return err
		}
	}
	s.hub.BroadcastSession(session.ID, "reload", map[string]any{})
	httpx.OK(w, map[string]any{"sent": sent, "errors": errs})
	return nil
}

func (s *Server) handleAddInvitation(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	status := session.Status
	if status != "draft" && status != "scheduled" && status != "invitations_sent" {
		httpx.Error(w, http.StatusBadRequest, "Can only add students before session is completed")
		return nil
	}
	type request struct {
		StudentID    int64 `json:"student_id"`
		TimeslotID   int64 `json:"timeslot_id"`
		InstructorID int64 `json:"instructor_id"`
	}
	in, ok := decode[request](w, r)
	if !ok {
		return nil
	}
	studentID, timeslotID, instructorID := in.StudentID, in.TimeslotID, in.InstructorID
	if studentID == 0 || timeslotID == 0 || instructorID == 0 {
		httpx.Error(w, http.StatusBadRequest, "student_id, timeslot_id, and instructor_id are required")
		return nil
	}
	id := r.PathValue("id")
	var slotID int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, instructorID).Scan(&slotID) != nil {
		httpx.Error(w, http.StatusBadRequest, "Instructor is not assigned to this session")
		return nil
	}
	if s.exists("SELECT 1 FROM invitations WHERE session_id = ? AND student_id = ? AND status NOT IN "+terminalStatuses, id, studentID) {
		httpx.Error(w, http.StatusConflict, "Student already has an active invitation for this session")
		return nil
	}
	if s.exists("SELECT 1 FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status NOT IN "+terminalStatuses, id, timeslotID, slotID) {
		httpx.Error(w, http.StatusConflict, "This slot is already occupied")
		return nil
	}
	token := newToken()
	if _, err := s.db.Exec("INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token) VALUES (?, ?, ?, ?, ?)",
		id, studentID, timeslotID, slotID, token); err != nil {
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
		if err := s.db.QueryRow("SELECT first_name, last_name, email FROM students WHERE id = ?", studentID).Scan(&first, &last, &to); err != nil {
			logf("Failed to send invitation email for manually added student: %v", err)
		} else {
			s.mailer.SendInvitation(email.InvitationParams{
				To: to, StudentName: first + " " + last, Date: session.Date, Token: token, ClubName: s.clubName(), Locale: s.emailLocale(),
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
	sessionID := session.ID
	s.hub.BroadcastSession(sessionID, "reload", map[string]any{})
	s.broadcastSessionCounts(sessionID)
	return nil
}

func (s *Server) handleAdminCancelInvitation(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	if session.Status == "completed" {
		httpx.Error(w, http.StatusBadRequest, "Session already completed")
		return nil
	}
	inv, found, err := s.findInvitation("WHERE inv.id = ? AND inv.session_id = ?", r.PathValue("invitationId"), r.PathValue("id"))
	if err != nil {
		return err
	}
	if !found {
		httpx.Error(w, http.StatusNotFound, "Invitation not found")
		return nil
	}
	switch st := inv.Status; st {
	case "declined", "expired", "invalidated", "cancelled", "admin_cancelled":
		httpx.Error(w, http.StatusBadRequest, "Cannot cancel — invitation is already "+st)
		return nil
	}
	invID, sessionID := inv.ID, session.ID
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
	if session.Status != "invitations_sent" {
		httpx.Error(w, http.StatusBadRequest, "Auto-scheduling is only available after invitations are sent")
		return nil
	}
	type request struct {
		TimeslotID   int64 `json:"timeslot_id"`
		InstructorID int64 `json:"instructor_id"`
	}
	in, ok := decode[request](w, r)
	if !ok {
		return nil
	}
	timeslotID, instructorID := in.TimeslotID, in.InstructorID
	if timeslotID == 0 || instructorID == 0 {
		httpx.Error(w, http.StatusBadRequest, "timeslot_id and instructor_id are required")
		return nil
	}
	id := r.PathValue("id")
	var slotID int64
	if s.db.QueryRow("SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, instructorID).Scan(&slotID) != nil {
		httpx.Error(w, http.StatusBadRequest, "Instructor is not assigned to this session")
		return nil
	}
	if s.exists("SELECT 1 FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status NOT IN "+terminalStatuses, id, timeslotID, slotID) {
		httpx.Error(w, http.StatusConflict, "This slot is already occupied")
		return nil
	}
	// Keep the group of the most recent vacated invitation for this spot, if there is one.
	var lastID int64
	var lastGroup *int64
	s.db.QueryRow("SELECT id, group_id FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status IN "+terminalStatuses+" ORDER BY responded_at DESC LIMIT 1",
		id, timeslotID, slotID).Scan(&lastID, &lastGroup)

	replacement, err := s.findAndInviteReplacement(vacatedSpot{
		SessionID: session.ID, SessionDate: session.Date, TimeslotID: timeslotID, SlotID: slotID,
		InvitationID: lastID, GroupID: lastGroup,
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
	switch session.Status {
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
	active, err := s.findInvitations(`
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
				To: inv.StudentEmail, StudentName: inv.StudentName, Date: session.Date,
				StartTime: inv.StartTime, DisciplineName: deref(inv.DisciplineName), ClubName: clubName, Locale: locale,
			})
		}
	}
	httpx.OK(w, map[string]any{"success": true, "cancelled_invitations": len(active)})
	sessionID := session.ID
	s.hub.BroadcastSession(sessionID, "reload", map[string]any{})
	s.broadcastSessionCounts(sessionID)
	for _, inv := range active {
		s.broadcastInvitation(inv.Token, "admin_cancelled")
	}
	return nil
}

func (s *Server) sessionCounts(sessionID int64) (map[string]any, error) {
	var total, confirmed int64
	err := s.db.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM invitations WHERE session_id = ?),
			(SELECT COUNT(*) FROM invitations WHERE session_id = ? AND status = 'confirmed')`,
		sessionID, sessionID).Scan(&total, &confirmed)
	return map[string]any{"session_id": sessionID, "invitation_count": total, "confirmed_count": confirmed}, err
}

func (s *Server) broadcastSessionCounts(sessionID int64) {
	counts, err := s.sessionCounts(sessionID)
	if err != nil {
		logf("session counts %d: %v", sessionID, err)
		return
	}
	s.hub.BroadcastSessionsList("session_counts_updated", counts)
}

// sessionFull reports whether every instructor x timeslot spot of the session is confirmed.
func (s *Server) sessionFull(sessionID int64) (bool, error) {
	var timetableID *int64
	if err := s.db.QueryRow("SELECT timetable_id FROM training_sessions WHERE id = ?", sessionID).Scan(&timetableID); err != nil || timetableID == nil {
		return false, nil
	}
	var instructors, timeslots, confirmed int64
	if err := s.db.QueryRow("SELECT COUNT(*) FROM session_slots WHERE session_id = ? AND removed = 0", sessionID).Scan(&instructors); err != nil {
		return false, err
	}
	if err := s.db.QueryRow("SELECT COUNT(*) FROM timeslots WHERE timetable_id = ?", *timetableID).Scan(&timeslots); err != nil {
		return false, err
	}
	total := instructors * timeslots
	if total == 0 {
		return false, nil
	}
	if err := s.db.QueryRow("SELECT COUNT(*) FROM invitations WHERE session_id = ? AND status = 'confirmed'", sessionID).Scan(&confirmed); err != nil {
		return false, err
	}
	return confirmed >= total, nil
}
