package server

import (
	"net/http"
	"strconv"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

// SSE channel names. Both the stream routes below and the broadcasters use these, so
// subscribers and publishers cannot drift apart.
const (
	sessionsListChannel  = "sessions-list"
	notificationsChannel = "notifications"
)

func sessionChannel(sessionID int64) string {
	return "session:" + strconv.FormatInt(sessionID, 10)
}

func invitationChannel(token string) string {
	return "invitation:" + token
}

// eventRoutes registers the SSE streams. They are long-lived, so they bypass wrap and
// must not hold s.mu.
func (s *Server) eventRoutes() {
	s.mux.HandleFunc("GET /api/sessions/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		s.hub.Serve(w, r, sessionsListChannel)
	}))

	s.mux.HandleFunc("GET /api/sessions/{id}/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Not found")
			return
		}

		s.hub.Serve(w, r, sessionChannel(id))
	}))

	s.mux.HandleFunc("GET /api/notifications/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		s.hub.Serve(w, r, notificationsChannel)
	}))

	s.mux.HandleFunc("GET /api/invitations/{token}/events", func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("token")
		if _, found, err := db.One[int](s.db, "SELECT 1 FROM invitations WHERE token = ?", token); err != nil {
			s.internalError(w, err)
			return
		} else if !found {
			httpx.Error(w, http.StatusNotFound, "Not found")
			return
		}

		s.hub.Serve(w, r, invitationChannel(token))
	})
}
