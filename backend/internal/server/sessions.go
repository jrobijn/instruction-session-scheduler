package server

import (
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

type Session struct {
	ID          int64   `db:"id" json:"id"`
	Date        string  `db:"date" json:"date"`     // YYYY-MM-DD
	Status      string  `db:"status" json:"status"` // draft, scheduled, invitations_sent, completed or cancelled
	TimetableID *int64  `db:"timetable_id" json:"timetable_id"`
	Notes       *string `db:"notes" json:"notes"`
}

// getSession loads the training session with the given id, reporting whether there is one.
func getSession(q db.Querier, id int64) (Session, bool, error) {
	return db.One[Session](q, "SELECT id, date, status, timetable_id, notes FROM training_sessions WHERE id = ?", id)
}

// SessionInvitation is an invitation as listed on the session page.
type SessionInvitation struct {
	ID                     int64   `db:"id" json:"id"`
	StudentID              int64   `db:"student_id" json:"student_id"`
	StudentName            string  `db:"student_name" json:"student_name"`
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
	InvitedAt              string  `db:"invited_at" json:"-"`              // for the effective status and expiry
	DecisionLog            *string `db:"decision_log" json:"decision_log"` // JSON, see batchLog and replacementLog
	BuddyGroupID           *int64  `db:"buddy_group_id" json:"buddy_group_id"`
	BuddyGroupName         *string `db:"buddy_group_name" json:"buddy_group_name"` // members' first names
	SessionDate            string  `db:"session_date" json:"-"`                    // for the effective status and expiry

	// Computed in GET /api/sessions/{id}.
	ExpiresAt *time.Time `db:"-" json:"expires_at"` // only while the invitation is open
}

// Session routes (schedule generation lives in schedule.go).
func (s *Server) sessionRoutes() {
	s.adminRoute("GET /api/sessions", func(w http.ResponseWriter, r *http.Request) error {
		type listItem struct {
			Session
			TimetableName   *string `db:"timetable_name" json:"timetable_name"`
			InstructorCount int64   `db:"instructor_count" json:"instructor_count"`
			InvitationCount int64   `db:"invitation_count" json:"invitation_count"`
			ConfirmedCount  int64   `db:"confirmed_count" json:"confirmed_count"`
			TotalSlots      int64   `db:"total_slots" json:"total_slots"` // instructors x timeslots
		}

		sessions, err := db.Many[listItem](s.db, `
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

	s.adminRoute("GET /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		// The session with everything the session page shows.
		type sessionDetail struct {
			Session
			Timetable               *Timetable          `json:"timetable"`
			Instructors             []Instructor        `json:"instructors"`
			Timeslots               []Timeslot          `json:"timeslots"`
			TimetableGroups         []TimetableGroup    `json:"timetableGroups"`
			Invitations             []SessionInvitation `json:"invitations"`
			InvitationExpiryMinutes float64             `json:"invitation_expiry_minutes"`
		}

		detail := sessionDetail{Session: session, Timeslots: []Timeslot{}, TimetableGroups: []TimetableGroup{}}
		if detail.Instructors, err = db.Many[Instructor](s.db, `
			SELECT i.id, i.first_name, i.last_name, i.email, i.active FROM instructors i
			JOIN session_slots si ON si.instructor_id = i.id
			WHERE si.session_id = ? AND si.removed = 0
			ORDER BY i.last_name ASC, i.first_name ASC`, id); err != nil {
			return err
		}

		if ttID := session.TimetableID; ttID != nil {
			if t, found, err := s.getTimetable(*ttID); err != nil {
				return err
			} else if found {
				detail.Timetable = &t
			}

			if detail.Timeslots, err = timetableTimeslots(s.db, *ttID); err != nil {
				return err
			}
			if detail.TimetableGroups, err = timetableGroups(s.db, *ttID); err != nil {
				return err
			}
		}

		if detail.Invitations, err = db.Many[SessionInvitation](s.db, `
			SELECT inv.id, inv.student_id,
				s.first_name || ' ' || s.last_name AS student_name, s.membership_id AS student_membership_id,
				ss.instructor_id, i.first_name || ' ' || i.last_name AS instructor_name,
				d.name AS discipline_name, d.abbreviation AS discipline_abbreviation,
				inv.status, inv.token, inv.timeslot_id, ts.start_time AS timeslot_start_time, inv.no_show,
				g.name AS group_name, g.color AS group_color, inv.invited_at, inv.decision_log, bgm.buddy_group_id,
				(SELECT NULLIF(group_concat(bs.first_name, ' & '), '')
					FROM buddy_group_members bm JOIN students bs ON bs.id = bm.student_id
					WHERE bm.buddy_group_id = bgm.buddy_group_id AND bs.deleted_at IS NULL) AS buddy_group_name,
				tsess.date AS session_date
			FROM invitations inv
			JOIN training_sessions tsess ON tsess.id = inv.session_id
			JOIN students s ON s.id = inv.student_id
			JOIN timeslots ts ON ts.id = inv.timeslot_id
			JOIN session_slots ss ON ss.id = inv.slot_id
			JOIN instructors i ON i.id = ss.instructor_id
			LEFT JOIN disciplines d ON d.id = inv.discipline_id
			LEFT JOIN groups g ON g.id = inv.group_id
			LEFT JOIN buddy_group_members bgm ON bgm.student_id = inv.student_id
			WHERE inv.session_id = ?
			ORDER BY ts.start_time ASC, i.last_name ASC, i.first_name ASC, inv.id ASC`, id); err != nil {
			return err
		}

		// The effective status and expiry deadline depend on the club's time zone and the
		// current time, so they are computed here rather than in SQL.
		minutes, loc, now := expiryMinutes(s.db), clubLocation(s.db), s.now()
		for i := range detail.Invitations {
			inv := &detail.Invitations[i]
			timing := invitationTiming{Status: inv.Status, InvitedAt: inv.InvitedAt, SessionDate: inv.SessionDate, StartTime: inv.TimeslotStartTime}
			inv.Status = effectiveStatus(timing, minutes, loc, now)

			// Like GET /api/invitations/{token}: a deadline only while the invitation is still open.
			if inv.Status == "invited" {
				if d, ok := invitationDeadline(inv.InvitedAt, inv.SessionDate, inv.TimeslotStartTime, minutes, loc); ok {
					d = d.UTC()
					inv.ExpiresAt = &d
				}
			}
		}

		detail.InvitationExpiryMinutes = minutes
		httpx.OK(w, detail)
		return nil
	})

	s.adminRoute("POST /api/sessions", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Date        string `json:"date"` // YYYY-MM-DD
			Notes       string `json:"notes"`
			TimetableID int64  `json:"timetable_id"` // 0 or null: the default timetable, if any
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		if in.Date == "" {
			httpx.Error(w, http.StatusBadRequest, "Date is required")
			return nil
		}

		dow, valid := dayOfWeek(in.Date)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "Invalid date")
			return nil
		}

		var ttID *int64
		if in.TimetableID != 0 {
			if _, found, err := db.One[int](s.db, "SELECT 1 FROM timetables WHERE id = ? AND status = 'saved' AND active = 1", in.TimetableID); err != nil {
				return err
			} else if !found {
				httpx.Error(w, http.StatusBadRequest, "Invalid timetable")
				return nil
			}

			ttID = &in.TimetableID
		} else if id, found, err := db.One[int64](s.db, "SELECT id FROM timetables WHERE is_default = 1 AND active = 1 AND status = 'saved'"); err != nil {
			return err
		} else if found {
			ttID = &id
		}

		row, err := db.Get[Session](s.db, "INSERT INTO training_sessions (date, day_of_week, notes, timetable_id) VALUES (?, ?, ?, ?) RETURNING id, date, status, timetable_id, notes",
			in.Date, dow, in.Notes, ttID)
		if isUniqueErr(err, "training_sessions.date") {
			httpx.Error(w, http.StatusConflict, "A training session already exists for this date")
			return nil
		}
		if err != nil {
			return err
		}

		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Date  *string `json:"date"`
			Notes *string `json:"notes"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		var dow any
		if in.Date != nil {
			d, valid := dayOfWeek(*in.Date)
			if !valid {
				httpx.Error(w, http.StatusBadRequest, "Invalid date")
				return nil
			}

			dow = d
		}

		row, found, err := db.One[Session](s.db, `
			UPDATE training_sessions SET
				date = COALESCE(?, date),
				day_of_week = COALESCE(?, day_of_week),
				notes = COALESCE(?, notes)
			WHERE id = ?
			RETURNING id, date, status, timetable_id, notes`,
			in.Date, dow, in.Notes, id)
		if isUniqueErr(err, "training_sessions.date") {
			httpx.Error(w, http.StatusConflict, "A training session already exists for this date")
			return nil
		}
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("PUT /api/sessions/{id}/timetable", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			TimetableID *int64 `json:"timetable_id"` // null or missing: no timetable
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		cur, next := session.TimetableID, in.TimetableID
		changed := (cur == nil) != (next == nil) || (cur != nil && *cur != *next)
		if changed && (session.Status == "invitations_sent" || session.Status == "completed") {
			httpx.Error(w, http.StatusBadRequest, "Cannot change timetable after invitations have been sent")
			return nil
		}

		// Only a newly picked timetable must be usable: a session keeps its current one
		// even after that timetable was deactivated.
		if changed && next != nil {
			if _, found, err := db.One[int](s.db, "SELECT 1 FROM timetables WHERE id = ? AND status = 'saved' AND active = 1", *next); err != nil {
				return err
			} else if !found {
				httpx.Error(w, http.StatusBadRequest, "Invalid timetable")
				return nil
			}
		}

		var row Session
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			if changed && session.Status == "scheduled" {
				// Changing the timetable clears the schedule.
				if _, err := tx.Exec("DELETE FROM invitations WHERE session_id = ?", id); err != nil {
					return err
				}

				if _, err := tx.Exec("UPDATE training_sessions SET status = 'draft' WHERE id = ?", id); err != nil {
					return err
				}
			}

			row, err = db.Get[Session](tx, `
				UPDATE training_sessions SET timetable_id = ? WHERE id = ?
				RETURNING id, date, status, timetable_id, notes`,
				next, id)
			return err
		})
		if err != nil {
			return err
		}

		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/sessions/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		// Invitations cascade away with the session, without emails, timers or history, so
		// only drafts (which have none) may be deleted; other sessions must be cancelled.
		if session.Status != "draft" {
			httpx.Error(w, http.StatusBadRequest, "Only draft sessions can be deleted")
			return nil
		}

		if _, err := s.db.Exec("DELETE FROM training_sessions WHERE id = ?", id); err != nil {
			return err
		}

		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/instructors", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			InstructorID int64 `json:"instructor_id"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		instructorID := in.InstructorID
		if instructorID == 0 {
			httpx.Error(w, http.StatusBadRequest, "instructor_id is required")
			return nil
		}

		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		if session.Status == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify a completed session")
			return nil
		}

		// Re-assigning a removed instructor revives their slot (and its invitation history).
		removedSlot, found, err := db.One[int64](s.db, "SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 1", id, instructorID)
		if err != nil {
			return err
		}
		if found {
			_, err = s.db.Exec("UPDATE session_slots SET removed = 0 WHERE id = ?", removedSlot)
		} else {
			_, err = s.db.Exec("INSERT INTO session_slots (session_id, instructor_id) VALUES (?, ?)", id, instructorID)
		}

		switch {
		case isUniqueErr(err, "session_slots.session_id", "session_slots.instructor_id"):
			httpx.Error(w, http.StatusConflict, "Instructor already assigned to this session")
			return nil
		case err != nil && strings.Contains(err.Error(), "FOREIGN KEY"):
			httpx.Error(w, http.StatusBadRequest, "Invalid instructor")
			return nil
		case err != nil:
			return err
		}

		httpx.JSON(w, http.StatusCreated, map[string]bool{"success": true})
		s.broadcastSessionReload(id)
		s.broadcastSessionCounts(id)
		return nil
	})

	s.adminRoute("DELETE /api/sessions/{id}/instructors/{instructorId}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		if session.Status == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify a completed session")
			return nil
		}

		instructorID, ok := pathID(r, "instructorId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Assignment not found")
			return nil
		}

		slotID, found, err := db.One[int64](s.db, "SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, instructorID)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Assignment not found")
			return nil
		}

		var cancelled int
		err = s.inTx(func(t *txn) error {
			cancelled, err = t.removeSlot(id, slotID)
			return err
		})
		if err != nil {
			return err
		}

		httpx.OK(w, map[string]any{"success": true, "cancelled": cancelled})
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/instructors/{instructorId}/replace", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			NewInstructorID int64 `json:"new_instructor_id"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		newID := in.NewInstructorID
		if newID == 0 {
			httpx.Error(w, http.StatusBadRequest, "new_instructor_id is required")
			return nil
		}

		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		if session.Status == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Cannot modify a completed session")
			return nil
		}

		oldID, ok := pathID(r, "instructorId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Original instructor not assigned to this session")
			return nil
		}

		if oldID == newID {
			httpx.Error(w, http.StatusBadRequest, "New instructor must be different")
			return nil
		}

		oldSlot, found, err := db.One[int64](s.db, "SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, oldID)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Original instructor not assigned to this session")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM instructors WHERE id = ? AND deleted_at IS NULL", newID); err != nil {
			return err
		} else if !found {
			httpx.Error(w, http.StatusBadRequest, "New instructor not found")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, newID); err != nil {
			return err
		} else if found {
			httpx.Error(w, http.StatusConflict, "New instructor is already assigned to this session")
			return nil
		}

		err = s.db.InTx(func(tx *sqlx.Tx) error {
			// A removed slot of the new instructor is merged into the old slot.
			removedSlot, found, err := db.One[int64](tx, "SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 1", id, newID)
			if err != nil {
				return err
			}
			if found {
				if _, err := tx.Exec("UPDATE invitations SET slot_id = ? WHERE slot_id = ?", oldSlot, removedSlot); err != nil {
					return err
				}

				if _, err := tx.Exec("DELETE FROM session_slots WHERE id = ?", removedSlot); err != nil {
					return err
				}
			}

			// Re-pointing the slot moves all its invitations to the new instructor.
			_, err = tx.Exec("UPDATE session_slots SET instructor_id = ? WHERE id = ?", newID, oldSlot)
			return err
		})
		if err != nil {
			return err
		}

		httpx.Success(w)
		s.broadcastSessionReload(id)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/generate-schedule", s.handleGenerateSchedule)

	s.adminRoute("POST /api/sessions/{id}/send-invitations", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM training_sessions WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		pending, err := db.Many[int64](s.db, "SELECT id FROM invitations WHERE session_id = ? AND email_sent = 0 AND status = 'scheduled'", id)
		if err != nil {
			return err
		}

		if len(pending) == 0 {
			httpx.OK(w, map[string]any{"message": "No pending invitations to send", "sent": 0})
			return nil
		}

		err = s.inTx(func(t *txn) error {
			for _, invID := range pending {
				if err := t.sendInvitation(invID); err != nil {
					return err
				}
			}

			_, err := t.q.Exec("UPDATE training_sessions SET status = 'invitations_sent' WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}

		s.broadcastSessionReload(id)
		httpx.OK(w, map[string]any{"sent": len(pending)})
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/invitations/{invitationId}/toggle-no-show", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
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

		invID, ok := pathID(r, "invitationId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}

		inv, found, err := db.One[noShowState](s.db, "SELECT id, status, no_show FROM invitations WHERE id = ? AND session_id = ?", invID, id)
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

		s.broadcastSessionInvitation(id, inv.ID, map[string]any{"no_show": newValue})
		httpx.OK(w, map[string]any{"success": true, "no_show": newValue})
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/complete", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		if session.Status == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Session already completed")
			return nil
		}

		type attendance struct {
			StudentID int64 `db:"student_id"`
			NoShow    int64 `db:"no_show"`
		}

		var confirmed []attendance
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			confirmed, err = db.Many[attendance](tx, "SELECT student_id, no_show FROM invitations WHERE session_id = ? AND status = 'confirmed'", id)
			if err != nil {
				return err
			}

			for _, c := range confirmed {
				column := "attended_sessions"
				if c.NoShow != 0 {
					column = "no_show_count"
				}

				if _, err := tx.Exec("UPDATE students SET "+column+" = "+column+" + 1 WHERE id = ?", c.StudentID); err != nil {
					return err
				}
			}

			_, err = tx.Exec("UPDATE training_sessions SET status = 'completed' WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}

		s.hub.Broadcast(sessionChannel(id), "session_updated", map[string]any{"status": "completed"})
		httpx.OK(w, map[string]any{"success": true, "students_credited": len(confirmed)})
		return nil
	})

	s.adminRoute("GET /api/sessions/{id}/available-students", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM training_sessions WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if utf8.RuneCountInString(q) < 2 {
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
					SELECT student_id FROM invitations WHERE session_id = ? AND status IN ('scheduled', 'invited', 'confirmed')
				)
			ORDER BY s.last_name ASC, s.first_name ASC
			LIMIT 15`, like, like, id)
		if err != nil {
			return err
		}

		httpx.OK(w, students)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/invitations", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
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

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		studentID, timeslotID, instructorID := in.StudentID, in.TimeslotID, in.InstructorID
		if studentID == 0 || timeslotID == 0 || instructorID == 0 {
			httpx.Error(w, http.StatusBadRequest, "student_id, timeslot_id, and instructor_id are required")
			return nil
		}

		slotID, found, err := db.One[int64](s.db, "SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, instructorID)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusBadRequest, "Instructor is not assigned to this session")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM students WHERE id = ? AND deleted_at IS NULL", studentID); err != nil {
			return err
		} else if !found {
			httpx.Error(w, http.StatusBadRequest, "Invalid student")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM timeslots WHERE id = ? AND timetable_id = ?", timeslotID, session.TimetableID); err != nil {
			return err
		} else if !found {
			httpx.Error(w, http.StatusBadRequest, "Timeslot is not part of this session's timetable")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM invitations WHERE session_id = ? AND student_id = ? AND status IN ('scheduled', 'invited', 'confirmed')", id, studentID); err != nil {
			return err
		} else if found {
			httpx.Error(w, http.StatusConflict, "Student already has an active invitation for this session")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status IN ('scheduled', 'invited', 'confirmed')", id, timeslotID, slotID); err != nil {
			return err
		} else if found {
			httpx.Error(w, http.StatusConflict, "This slot is already occupied")
			return nil
		}

		err = s.inTx(func(t *txn) error {
			newID, err := db.Get[int64](t.q, "INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token) VALUES (?, ?, ?, ?, ?) RETURNING id",
				id, studentID, timeslotID, slotID, uuid.NewString())
			if err != nil {
				return err
			}

			switch status {
			case "draft":
				_, err = t.q.Exec("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?", id)
			case "invitations_sent":
				// After invitations went out, a manually added student is invited right away.
				err = t.sendInvitation(newID)
			}

			return err
		})
		if err != nil {
			return err
		}

		httpx.JSON(w, http.StatusCreated, map[string]bool{"success": true})
		s.broadcastSessionReload(id)
		s.broadcastSessionCounts(id)
		return nil
	})

	s.adminRoute("DELETE /api/sessions/{id}/invitations/{invitationId}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		if session.Status != "draft" && session.Status != "scheduled" {
			httpx.Error(w, http.StatusBadRequest, "Can only remove students before invitations are sent")
			return nil
		}

		invID, ok := pathID(r, "invitationId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}

		var deleted int64
		err = s.db.InTx(func(tx *sqlx.Tx) error {
			res, err := tx.Exec("DELETE FROM invitations WHERE id = ? AND session_id = ?", invID, id)
			if err != nil {
				return err
			}
			if deleted, err = res.RowsAffected(); err != nil || deleted == 0 {
				return err
			}

			// With no invitations left the session reverts to draft.
			_, err = tx.Exec("UPDATE training_sessions SET status = 'draft' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM invitations WHERE session_id = ?)", id, id)
			return err
		})
		if err != nil {
			return err
		}

		if deleted == 0 {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}

		httpx.Success(w)
		s.broadcastSessionReload(id)
		s.broadcastSessionCounts(id)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/invitations/{invitationId}/admin-cancel", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		if session.Status == "completed" {
			httpx.Error(w, http.StatusBadRequest, "Session already completed")
			return nil
		}

		invID, ok := pathID(r, "invitationId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}

		st, found, err := db.One[string](s.db, "SELECT status FROM invitations WHERE id = ? AND session_id = ?", invID, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Invitation not found")
			return nil
		}

		if st != "scheduled" && st != "invited" && st != "confirmed" {
			httpx.Error(w, http.StatusBadRequest, "Cannot cancel — invitation is already "+st)
			return nil
		}

		if err := s.inTx(func(t *txn) error { return t.adminCancelInvitation(invID) }); err != nil {
			return err
		}

		s.broadcastSessionInvitation(id, invID, map[string]any{"status": "admin_cancelled"})
		s.broadcastSessionCounts(id)
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/auto-schedule-slot", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		if session.Status != "invitations_sent" {
			httpx.Error(w, http.StatusBadRequest, "Auto-scheduling is only available after invitations are sent")
			return nil
		}

		type request struct {
			TimeslotID   int64 `json:"timeslot_id"`
			InstructorID int64 `json:"instructor_id"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		timeslotID, instructorID := in.TimeslotID, in.InstructorID
		if timeslotID == 0 || instructorID == 0 {
			httpx.Error(w, http.StatusBadRequest, "timeslot_id and instructor_id are required")
			return nil
		}

		slotID, found, err := db.One[int64](s.db, "SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0", id, instructorID)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusBadRequest, "Instructor is not assigned to this session")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status IN ('scheduled', 'invited', 'confirmed')", id, timeslotID, slotID); err != nil {
			return err
		} else if found {
			httpx.Error(w, http.StatusConflict, "This slot is already occupied")
			return nil
		}

		// Keep the group of the most recent vacated invitation for this spot, if there is one.
		type vacated struct {
			ID      int64  `db:"id"`
			GroupID *int64 `db:"group_id"`
		}

		last, _, err := db.One[vacated](s.db, "SELECT id, group_id FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status NOT IN ('scheduled', 'invited', 'confirmed') ORDER BY responded_at DESC LIMIT 1",
			id, timeslotID, slotID)
		if err != nil {
			return err
		}

		var replaced bool
		err = s.inTx(func(t *txn) error {
			replaced, err = t.findAndInviteReplacement(vacatedSpot{
				SessionID: id, SessionDate: session.Date, TimeslotID: timeslotID, SlotID: slotID,
				InvitationID: last.ID, GroupID: last.GroupID,
			})
			return err
		})
		if err != nil {
			return err
		}

		httpx.OK(w, map[string]any{"success": true, "replaced": replaced})
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/cancel", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		switch session.Status {
		case "completed":
			httpx.Error(w, http.StatusBadRequest, "Cannot cancel a completed session")
			return nil
		case "cancelled":
			httpx.Error(w, http.StatusBadRequest, "Session is already cancelled")
			return nil
		}

		open, err := db.Many[struct {
			ID     int64  `db:"id"`
			Status string `db:"status"`
		}](s.db, "SELECT id, status FROM invitations WHERE session_id = ? AND status IN ('scheduled', 'invited', 'confirmed')", id)
		if err != nil {
			return err
		}

		cancelled := 0 // invitations the students knew about
		err = s.inTx(func(t *txn) error {
			for _, inv := range open {
				if err := t.adminCancelInvitation(inv.ID); err != nil {
					return err
				}

				if inv.Status != "scheduled" {
					cancelled++
				}
			}

			_, err := t.q.Exec("UPDATE training_sessions SET status = 'cancelled' WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}

		httpx.OK(w, map[string]any{"success": true, "cancelled_invitations": cancelled})
		s.broadcastSessionReload(id)
		s.broadcastSessionCounts(id)
		return nil
	})

	s.adminRoute("POST /api/sessions/{id}/reactivate", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		session, found, err := getSession(s.db, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Training session not found")
			return nil
		}

		if session.Status != "cancelled" {
			httpx.Error(w, http.StatusBadRequest, "Only cancelled sessions can be reactivated")
			return nil
		}

		err = s.db.InTx(func(tx *sqlx.Tx) error {
			if _, err := tx.Exec("DELETE FROM invitations WHERE session_id = ?", id); err != nil {
				return err
			}

			_, err := tx.Exec("UPDATE training_sessions SET status = 'draft' WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}

		httpx.OK(w, map[string]any{"success": true, "new_status": "draft"})
		s.broadcastSessionReload(id)
		s.broadcastSessionCounts(id)
		return nil
	})
}

// removeSlot takes an instructor's slot out of a session: active invitations on it are
// admin-cancelled, unsent ones deleted, and older ones kept as history. It returns the number
// of cancelled invitations.
func (t *txn) removeSlot(sessionID int64, slotID int64) (int, error) {
	affected, err := db.Many[struct {
		ID     int64  `db:"id"`
		Status string `db:"status"`
	}](t.q, "SELECT id, status FROM invitations WHERE slot_id = ?", slotID)
	if err != nil {
		return 0, err
	}

	cancelled := 0
	for _, inv := range affected {
		switch inv.Status {
		case "invited", "confirmed":
			cancelled++
			if err := t.adminCancelInvitation(inv.ID); err != nil {
				return 0, err
			}
		case "scheduled":
			// Not sent yet: just delete.
			if _, err := t.q.Exec("DELETE FROM invitations WHERE id = ?", inv.ID); err != nil {
				return 0, err
			}
		}

		// Other statuses are history and stay linked to the slot.
	}

	if _, err := t.q.Exec("UPDATE session_slots SET removed = 1 WHERE id = ?", slotID); err != nil {
		return 0, err
	}

	t.afterCommit(func(s *Server) {
		s.broadcastSessionReload(sessionID)
		s.broadcastSessionCounts(sessionID)
	})

	return cancelled, nil
}

func (s *Server) broadcastSessionCounts(sessionID int64) {
	counts, err := db.Get[struct {
		Total     int64 `db:"total"`
		Confirmed int64 `db:"confirmed"`
	}](s.db, `
		SELECT
			(SELECT COUNT(*) FROM invitations WHERE session_id = ?) AS total,
			(SELECT COUNT(*) FROM invitations WHERE session_id = ? AND status = 'confirmed') AS confirmed`,
		sessionID, sessionID)
	if err != nil {
		log.Printf("session counts %d: %v", sessionID, err)
		return
	}

	s.hub.Broadcast(sessionsListChannel, "session_counts_updated", map[string]any{
		"session_id":       sessionID,
		"invitation_count": counts.Total,
		"confirmed_count":  counts.Confirmed,
	})
}

// broadcastSessionInvitation pushes a partial invitation update to the admin session channel.
// fields holds the changed columns; the invitation id is added here.
func (s *Server) broadcastSessionInvitation(sessionID, invID int64, fields map[string]any) {
	fields["id"] = invID
	s.hub.Broadcast(sessionChannel(sessionID), "invitation_updated", fields)
}

// broadcastSessionReload tells admin session-channel subscribers to refetch the whole session.
func (s *Server) broadcastSessionReload(sessionID int64) {
	s.hub.Broadcast(sessionChannel(sessionID), "reload", map[string]any{})
}

// sessionFull reports whether every instructor x timeslot spot of the session is confirmed.
// A session without a timetable has no timeslots, so it is never full.
func (s *Server) sessionFull(sessionID int64) (bool, error) {
	full, _, err := db.One[bool](s.db, `
		SELECT total > 0 AND confirmed >= total FROM (
			SELECT
				(SELECT COUNT(*) FROM session_slots WHERE session_id = ts.id AND removed = 0) *
					(SELECT COUNT(*) FROM timeslots WHERE timetable_id = ts.timetable_id) AS total,
				(SELECT COUNT(*) FROM invitations WHERE session_id = ts.id AND status = 'confirmed') AS confirmed
			FROM training_sessions ts WHERE ts.id = ?
		)`, sessionID)
	return full, err
}
