package server

import (
	"log"
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

		var total int64
		if err := s.db.QueryRow("SELECT COUNT(*) FROM notifications").Scan(&total); err != nil {
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
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Notification not found")
			return nil
		}
		res, err := s.db.Exec("UPDATE notifications SET read = 1 WHERE id = ?", id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			httpx.Error(w, http.StatusNotFound, "Notification not found")
			return nil
		}
		count, err := s.unreadCount()
		if err != nil {
			return err
		}
		s.hub.Broadcast(notificationsChannel, "unread_count_updated", map[string]int64{"unread_count": count})
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/notifications/read-all", func(w http.ResponseWriter, r *http.Request) error {
		if _, err := s.db.Exec("UPDATE notifications SET read = 1 WHERE read = 0"); err != nil {
			return err
		}
		s.hub.Broadcast(notificationsChannel, "unread_count_updated", map[string]int64{"unread_count": 0})
		httpx.Success(w)
		return nil
	})
}

func (s *Server) unreadCount() (int64, error) {
	var n int64
	err := s.db.QueryRow("SELECT COUNT(*) FROM notifications WHERE read = 0").Scan(&n)
	return n, err
}

// notifyInvitation records a notification about a student's invitation, such as invitation_confirmed.
func (s *Server) notifyInvitation(typ string, inv invitationDetails) {
	s.createNotification(typ, inv.ID, inv.SessionID, inv.StudentName, inv.SessionDate, inv.StartTime)
}

// notifySession records a notification about a whole session, such as session_full. It has no
// invitation, student or timeslot, so those columns are NULL (student_name is empty).
func (s *Server) notifySession(typ string, sessionID int64, sessionDate string) {
	s.createNotification(typ, nil, sessionID, "", sessionDate, nil)
}

// createNotification inserts a notification and broadcasts it to SSE listeners.
// It logs instead of failing: notifications are a side effect of the caller's real work.
func (s *Server) createNotification(typ string, invitationID any, sessionID int64, studentName, sessionDate string, startTime any) {
	notification, err := db.Get[Notification](s.db, `
		INSERT INTO notifications (type, invitation_id, session_id, student_name, session_date, timeslot_start_time)
		VALUES (?, ?, ?, ?, ?, ?)
		RETURNING id, type, invitation_id, session_id, student_name, session_date, timeslot_start_time, read, created_at`,
		typ, invitationID, sessionID, studentName, sessionDate, startTime)
	if err != nil {
		log.Printf("create notification %s for session %d: %v", typ, sessionID, err)
		return
	}
	count, err := s.unreadCount()
	if err != nil {
		log.Printf("count unread notifications: %v", err)
		return
	}
	s.hub.Broadcast(notificationsChannel, "new_notification", map[string]any{"notification": notification, "unread_count": count})
}
