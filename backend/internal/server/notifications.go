package server

import (
	"net/http"
	"strconv"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

type Notification struct {
	ID                int64   `db:"id" json:"id"`
	Type              string  `db:"type" json:"type"`
	InvitationID      *int64  `db:"invitation_id" json:"invitation_id"`
	SessionID         *int64  `db:"session_id" json:"session_id"`
	StudentName       string  `db:"student_name" json:"student_name"`
	SessionDate       string  `db:"session_date" json:"session_date"`
	TimeslotStartTime *string `db:"timeslot_start_time" json:"timeslot_start_time"`
	Read              int64   `db:"read" json:"read"`
	CreatedAt         string  `db:"created_at" json:"created_at"`
}

// NewNotification is the input of createNotification in notifications.ts. Zero values are
// stored as NULL (an empty string for StudentName), matching the `|| null` defaults there.
type NewNotification struct {
	Type              string
	InvitationID      int64
	SessionID         int64
	StudentName       string
	SessionDate       string
	TimeslotStartTime string
}

func (s *Server) notificationRoutes() {
	s.adminRoute("GET /api/notifications", func(w http.ResponseWriter, r *http.Request) error {
		page := 1
		if n, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && n != 0 {
			page = max(1, n)
		}
		limit := 20
		if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n != 0 {
			limit = min(100, max(1, n))
		}
		offset := (page - 1) * limit

		total, err := s.unreadOrTotal("SELECT COUNT(*) FROM notifications")
		if err != nil {
			return err
		}
		notifications, err := db.Many[Notification](s.db, `
			SELECT id, type, invitation_id, session_id, student_name, session_date, timeslot_start_time, read, created_at
			FROM notifications
			ORDER BY created_at DESC, id DESC
			LIMIT ? OFFSET ?`, limit, offset)
		if err != nil {
			return err
		}
		httpx.OK(w, map[string]any{"notifications": notifications, "total": total, "page": page, "limit": limit})
		return nil
	})

	s.adminRoute("GET /api/notifications/unread-count", func(w http.ResponseWriter, r *http.Request) error {
		count, err := s.unreadCount()
		if err != nil {
			return err
		}
		httpx.OK(w, map[string]int64{"count": count})
		return nil
	})

	s.adminRoute("POST /api/notifications/{id}/read", func(w http.ResponseWriter, r *http.Request) error {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "Invalid id")
			return nil
		}
		if _, err := s.db.Exec("UPDATE notifications SET read = 1 WHERE id = ?", id); err != nil {
			return err
		}
		count, err := s.unreadCount()
		if err != nil {
			return err
		}
		s.hub.Broadcast("notifications", "unread_count_updated", map[string]int64{"unread_count": count})
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/notifications/read-all", func(w http.ResponseWriter, r *http.Request) error {
		if _, err := s.db.Exec("UPDATE notifications SET read = 1 WHERE read = 0"); err != nil {
			return err
		}
		s.hub.Broadcast("notifications", "unread_count_updated", map[string]int64{"unread_count": 0})
		httpx.Success(w)
		return nil
	})
}

func (s *Server) unreadOrTotal(query string) (int64, error) {
	var n int64
	err := s.db.QueryRow(query).Scan(&n)
	return n, err
}

func (s *Server) unreadCount() (int64, error) {
	return s.unreadOrTotal("SELECT COUNT(*) FROM notifications WHERE read = 0")
}

// CreateNotification inserts a notification and broadcasts it to SSE listeners.
// It logs instead of failing: notifications are a side effect of the caller's real work.
func (s *Server) CreateNotification(n NewNotification) {
	var invitationID, sessionID, startTime any
	if n.InvitationID != 0 {
		invitationID = n.InvitationID
	}
	if n.SessionID != 0 {
		sessionID = n.SessionID
	}
	if n.TimeslotStartTime != "" {
		startTime = n.TimeslotStartTime
	}
	res, err := s.db.Exec(`
		INSERT INTO notifications (type, invitation_id, session_id, student_name, session_date, timeslot_start_time)
		VALUES (?, ?, ?, ?, ?, ?)`,
		n.Type, invitationID, sessionID, n.StudentName, n.SessionDate, startTime)
	if err != nil {
		logf("create notification %s for session %d: %v", n.Type, n.SessionID, err)
		return
	}
	notification, _, err := db.One[Notification](s.db, `
		SELECT id, type, invitation_id, session_id, student_name, session_date, timeslot_start_time, read, created_at
		FROM notifications WHERE id = ?`, lastID(res))
	if err != nil {
		logf("load notification: %v", err)
		return
	}
	count, err := s.unreadCount()
	if err != nil {
		logf("count unread notifications: %v", err)
		return
	}
	s.hub.Broadcast("notifications", "new_notification", map[string]any{"notification": notification, "unread_count": count})
}
