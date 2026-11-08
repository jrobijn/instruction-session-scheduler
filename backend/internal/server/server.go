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

const authCookie = "auth_token"

type Server struct {
	cfg    config.Config
	db     *db.DB
	hub    *sse.Hub
	mailer *email.Mailer
	mux    *http.ServeMux
	timers *expiryTimers

	// mu serializes request handlers and timer callbacks. The TS backend runs on a single
	// event loop with a synchronous SQLite driver, so its multi-statement read-modify-write
	// sequences never interleave; this lock preserves that. SSE streams do not hold it.
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
	s.locked(s.rehydrateTimers)
}

// Stop cancels all expiry timers.
func (s *Server) Stop() {
	s.clearAllTimers()
}

func (s *Server) locked(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn()
}

func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) routes() {
	m := s.mux

	m.HandleFunc("POST /api/auth/login", s.handleLogin)
	m.HandleFunc("POST /api/auth/logout", s.handleLogout)
	m.HandleFunc("GET /api/auth/me", s.handleMe)

	// SSE streams authenticate via cookie themselves (same as the TS backend).
	m.HandleFunc("GET /api/sessions/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		s.hub.Serve(w, r, "sessions-list")
	}))
	m.HandleFunc("GET /api/sessions/{id}/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		s.hub.Serve(w, r, "session:"+r.PathValue("id"))
	}))
	m.HandleFunc("GET /api/notifications/events", s.admin(func(w http.ResponseWriter, r *http.Request) {
		s.hub.Serve(w, r, "notifications")
	}))
	m.HandleFunc("GET /api/invitations/{token}/events", s.handleInvitationEvents)

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

	m.HandleFunc("GET /api/public/disciplines", s.handlePublicDisciplines)
	m.HandleFunc("GET /api/public/disciplines/{token}", s.handlePublicDisciplinesForToken)

	m.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.OK(w, map[string]string{"status": "ok"})
	})

	m.HandleFunc("/", s.handleStatic)
}

// admin wraps a handler with the requireAdmin check from index.ts.
func (s *Server) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(authCookie)
		if err != nil || c.Value == "" {
			httpx.Error(w, http.StatusUnauthorized, "Authentication required")
			return
		}
		if _, err := auth.Verify(s.cfg.JWTSecret, c.Value); err != nil {
			httpx.Error(w, http.StatusForbidden, "Invalid or expired token")
			return
		}
		next(w, r)
	}
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password *string `json:"password"`
	}
	if err := httpx.Decode(r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	// Strict equality like the TS version: an unset ADMIN_PASSWORD never matches a sent password.
	if body.Password == nil || s.cfg.AdminPassword == "" || *body.Password != s.cfg.AdminPassword {
		httpx.Error(w, http.StatusUnauthorized, "Invalid password")
		return
	}
	token, err := auth.Sign(s.cfg.JWTSecret, "admin", 24*time.Hour)
	if err != nil {
		s.internalError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     authCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.Production,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   24 * 60 * 60,
		Expires:  time.Now().Add(24 * time.Hour),
	})
	httpx.Success(w)
}

func (s *Server) handleLogout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:    authCookie,
		Value:   "",
		Path:    "/",
		Expires: time.Unix(0, 0),
	})
	httpx.Success(w)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(authCookie)
	if err != nil || c.Value == "" {
		httpx.Error(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	if _, err := auth.Verify(s.cfg.JWTSecret, c.Value); err != nil {
		httpx.Error(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	httpx.OK(w, map[string]bool{"authenticated": true})
}

func (s *Server) handleInvitationEvents(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	var sessionID int64
	if err := s.db.QueryRow("SELECT session_id FROM invitations WHERE token = ?", token).Scan(&sessionID); err != nil {
		httpx.Error(w, http.StatusNotFound, "Not found")
		return
	}
	s.hub.Serve(w, r, "invitation:"+token)
}

// handleStatic serves the built frontend, falling back to index.html for client-side routes.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
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
}

func (s *Server) internalError(w http.ResponseWriter, err error) {
	log.Printf("internal error: %v", err)
	httpx.Error(w, http.StatusInternalServerError, "Internal server error")
}
