package server

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

// --- server-sent events -----------------------------------------------------------------

// readEvent reads the stream until an "event:" line and returns it with its data line.
func readEvent(t *testing.T, sc *bufio.Scanner) (string, string) {
	t.Helper()
	for sc.Scan() {
		if ev, ok := strings.CutPrefix(sc.Text(), "event: "); ok {
			sc.Scan()
			return ev, strings.TrimPrefix(sc.Text(), "data: ")
		}
	}
	t.Fatalf("stream ended: %v", sc.Err())
	return "", ""
}

func TestInvitationEventsStream(t *testing.T) {
	f, _ := invitedPair(t)
	ts := httptest.NewServer(f.handler)
	defer ts.Close()

	f.public(http.MethodGet, "/api/invitations/unknown/events", nil).wantError(http.StatusNotFound, "Not found")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/invitations/"+f.tokenOf("A")+"/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Scan() // the initial blank line confirms the subscription is in place

	f.invitationAction("A", "decline", nil).status(http.StatusOK)
	ev, data := readEvent(t, sc)
	if ev != "invitation_updated" || data != `{"status":"declined"}` {
		t.Fatalf("event %q data %s", ev, data)
	}
}

func TestSessionEventsStream(t *testing.T) {
	f, _ := invitedPair(t)
	ts := httptest.NewServer(f.handler)
	defer ts.Close()

	f.admin(http.MethodGet, "/api/sessions/abc/events", nil).wantError(http.StatusNotFound, "Not found")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+sessionPath(f.sessionID, "events"), nil)
	req.AddCookie(f.cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Scan()

	f.invitationAction("A", "confirm", map[string]any{}).status(http.StatusOK)
	ev, data := readEvent(t, sc)
	if ev != "invitation_updated" || !strings.Contains(data, `"status":"confirmed"`) {
		t.Fatalf("event %q data %s", ev, data)
	}
}
