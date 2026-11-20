package server

import (
	"net/http"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/auth"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

const authCookie = "auth_token"

func (s *Server) authRoutes() {
	s.mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		type request struct {
			Password *string `json:"password"`
		}
		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		// An unset ADMIN_PASSWORD never matches, not even an empty sent password.
		if in.Password == nil || s.cfg.AdminPassword == "" || *in.Password != s.cfg.AdminPassword {
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
	})

	s.mux.HandleFunc("POST /api/auth/logout", func(w http.ResponseWriter, _ *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name:    authCookie,
			Value:   "",
			Path:    "/",
			Expires: time.Unix(0, 0),
		})
		httpx.Success(w)
	})

	s.mux.HandleFunc("GET /api/auth/me", s.admin(func(w http.ResponseWriter, _ *http.Request) {
		httpx.OK(w, map[string]bool{"authenticated": true})
	}))
}
