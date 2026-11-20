package server

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/auth"
)

// --- auth -------------------------------------------------------------------------------

func TestAuthChecks(t *testing.T) {
	e := newTestEnv(t)
	e.public(http.MethodGet, "/api/students", nil).wantError(http.StatusUnauthorized, "Authentication required")
	e.public(http.MethodGet, "/api/auth/me", nil).wantError(http.StatusUnauthorized, "Authentication required")

	expired, _ := auth.Sign(testJWTSecret, "admin", -time.Minute)
	otherSecret, _ := auth.Sign("other-secret", "admin", time.Hour)
	for name, token := range map[string]string{"expired": expired, "wrong secret": otherSecret, "garbage": "not-a-jwt"} {
		t.Run(name, func(t *testing.T) {
			e.cookie = &http.Cookie{Name: authCookie, Value: token}
			e.admin(http.MethodGet, "/api/students", nil).wantError(http.StatusUnauthorized, "Invalid or expired token")
			// SSE streams are admin-only too.
			e.admin(http.MethodGet, "/api/sessions/events", nil).wantError(http.StatusUnauthorized, "Invalid or expired token")
		})
	}
}

// --- misc routes ------------------------------------------------------------------------

func TestHealth(t *testing.T) {
	e := newTestEnv(t)
	if got := e.public(http.MethodGet, "/api/health", nil).status(http.StatusOK).object(); got["status"] != "ok" {
		t.Fatalf("health = %v", got)
	}
}

func TestStaticFiles(t *testing.T) {
	e := newTestEnv(t)
	dir := e.srv.cfg.PublicDir
	write := func(name, content string) {
		p := filepath.Join(dir, name)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	e.public(http.MethodGet, "/sessions/3", nil).status(http.StatusNotFound) // no build yet

	write("index.html", "<html>app</html>")
	write("assets/app.js", "console.log(1)")
	write(".env", "SECRET=1")

	for path, want := range map[string]string{
		"/":              "<html>app</html>",
		"/assets/app.js": "console.log(1)",
		"/sessions/3":    "<html>app</html>", // client-side route
		"/.env":          "<html>app</html>", // dotfiles are not served
		"/etc/hosts":     "<html>app</html>", // resolved inside the public dir
	} {
		if got := string(e.public(http.MethodGet, path, nil).status(http.StatusOK).Body); got != want {
			t.Errorf("GET %s = %q, want %q", path, got, want)
		}
	}
	e.public(http.MethodPost, "/anything", nil).status(http.StatusNotFound)

	// The router cleans ".." segments with a redirect before the handler sees the path.
	res := e.public(http.MethodGet, "/assets/../../../etc/hosts", nil).status(http.StatusTemporaryRedirect)
	if loc := res.rec.Header().Get("Location"); loc != "/etc/hosts" {
		t.Errorf("Location = %q", loc)
	}
}
