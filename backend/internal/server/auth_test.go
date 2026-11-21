package server

import (
	"net/http"
	"testing"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/auth"
)

func TestLogin(t *testing.T) {
	e := newTestEnv(t)
	e.public(http.MethodPost, "/api/auth/login", map[string]any{"password": "wrong"}).wantError(http.StatusUnauthorized, "Invalid password")
	e.public(http.MethodPost, "/api/auth/login", map[string]any{}).wantError(http.StatusUnauthorized, "Invalid password")
	e.public(http.MethodPost, "/api/auth/login", "{").wantError(http.StatusBadRequest, "Invalid JSON body")

	res := e.public(http.MethodPost, "/api/auth/login", map[string]any{"password": testAdminPassword}).status(http.StatusOK)
	var cookie *http.Cookie
	for _, c := range res.rec.Result().Cookies() {
		if c.Name == authCookie {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 86400 || cookie.Secure {
		t.Fatalf("auth cookie = %+v", cookie)
	}
	if _, err := auth.Verify(testJWTSecret, cookie.Value); err != nil {
		t.Fatalf("cookie token does not verify: %v", err)
	}

	// The issued cookie authenticates admin routes.
	e.cookie = cookie
	e.admin(http.MethodGet, "/api/auth/me", nil).status(http.StatusOK)
	e.admin(http.MethodGet, "/api/settings", nil).status(http.StatusOK)
}

func TestLoginSecureCookieInProduction(t *testing.T) {
	e := newTestEnv(t)
	e.srv.cfg.Production = true
	res := e.public(http.MethodPost, "/api/auth/login", map[string]any{"password": testAdminPassword}).status(http.StatusOK)
	if c := res.rec.Result().Cookies(); len(c) != 1 || !c[0].Secure {
		t.Fatalf("cookies = %+v, want a Secure cookie", c)
	}
}

func TestLoginWithoutConfiguredPasswordAlwaysFails(t *testing.T) {
	e := newTestEnv(t)
	e.srv.cfg.AdminPassword = ""
	e.public(http.MethodPost, "/api/auth/login", map[string]any{"password": ""}).wantError(http.StatusUnauthorized, "Invalid password")
}

func TestLogout(t *testing.T) {
	e := newTestEnv(t)
	res := e.admin(http.MethodPost, "/api/auth/logout", nil).status(http.StatusOK)
	c := res.rec.Result().Cookies()
	if len(c) != 1 || c[0].Name != authCookie || c[0].Value != "" || !c[0].Expires.Before(time.Now()) {
		t.Fatalf("logout cookies = %+v", c)
	}
}
