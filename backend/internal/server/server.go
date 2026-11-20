// Package server wires the HTTP routes.
package server

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/auth"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/config"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/sse"
)

type Server struct {
	cfg    config.Config
	db     *db.DB
	hub    *sse.Hub
	mailer *email.Mailer
	mux    *http.ServeMux
	timers *expiryTimers

	// mu serializes request handlers and timer callbacks. Handlers do multi-statement
	// read-modify-write sequences (capacity checks, invitation state transitions) without
	// transactions, and timers race with handlers on the same rows; holding mu for the whole
	// handler makes each one atomic. SSE streams do not hold it.
	mu sync.Mutex

	// onExpirySettingsChanged is called after invitation_expiry_minutes or timezone changes,
	// so expiry timers can be rescheduled.
	onExpirySettingsChanged func()
}

func New(cfg config.Config, database *db.DB, hub *sse.Hub, mailer *email.Mailer) *Server {
	s := &Server{
		cfg: cfg, db: database, hub: hub, mailer: mailer,
		mux:    http.NewServeMux(),
		timers: &expiryTimers{timers: map[int64]*time.Timer{}},
	}
	s.onExpirySettingsChanged = s.rehydrateTimers
	s.routes()
	return s
}

// Start schedules expiry timers for pending invitations; call once before serving.
func (s *Server) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rehydrateTimers()
}

// Stop cancels all expiry timers.
func (s *Server) Stop() {
	s.clearAllTimers()
}

func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) routes() {
	m := s.mux

	s.authRoutes()

	// SSE streams are long-lived, so they bypass wrap and must not hold s.mu.
	m.HandleFunc("GET /api/sessions/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		s.hub.Serve(w, r, sessionsListChannel)
	}))
	m.HandleFunc("GET /api/sessions/{id}/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Not found")
			return
		}
		s.hub.Serve(w, r, sessionChannel(id))
	}))
	m.HandleFunc("GET /api/notifications/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		s.hub.Serve(w, r, notificationsChannel)
	}))
	m.HandleFunc("GET /api/invitations/{token}/events", func(w http.ResponseWriter, r *http.Request) {
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

	s.settingsRoutes()
	s.notificationRoutes()
	s.buddyGroupRoutes()
	s.instructorRoutes()
	s.disciplineRoutes()
	s.timetableRoutes()
	s.groupRoutes()
	s.studentRoutes()
	s.sessionRoutes()
	s.invitationRoutes()

	m.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.OK(w, map[string]string{"status": "ok"})
	})

	// Serve the built frontend, falling back to index.html for client-side routes.
	m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		clean := filepath.Clean("/" + r.URL.Path)
		candidate := filepath.Join(s.cfg.PublicDir, filepath.FromSlash(clean))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && !strings.Contains(clean, "/.") {
			http.ServeFile(w, r, candidate)
			return
		}
		index := filepath.Join(s.cfg.PublicDir, "index.html")
		if _, err := os.Stat(index); err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, index)
	})
}

// admin wraps a handler, rejecting requests without a valid admin auth cookie.
func (s *Server) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(authCookie)
		if err != nil || c.Value == "" {
			httpx.Error(w, http.StatusUnauthorized, "Authentication required")
			return
		}
		if _, err := auth.Verify(s.cfg.JWTSecret, c.Value); err != nil {
			httpx.Error(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}
		next(w, r)
	}
}

// handlerFunc is an http.HandlerFunc that may return an error. Handlers write every
// response themselves, client errors included (httpx.Error, then return nil); a returned
// error is always unexpected and becomes a 500. A handler that returns an error must not
// have written a response.
type handlerFunc func(w http.ResponseWriter, r *http.Request) error

func (s *Server) wrap(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if err := fn(w, r); err != nil {
			s.internalError(w, err)
		}
	}
}

// adminRoute registers an authenticated route.
func (s *Server) adminRoute(pattern string, fn handlerFunc) {
	s.mux.HandleFunc(pattern, s.admin(s.wrap(fn)))
}

// publicRoute registers an unauthenticated route.
func (s *Server) publicRoute(pattern string, fn handlerFunc) {
	s.mux.HandleFunc(pattern, s.wrap(fn))
}

func (s *Server) internalError(w http.ResponseWriter, err error) {
	log.Printf("internal error: %v", err)
	httpx.Error(w, http.StatusInternalServerError, "Internal server error")
}
