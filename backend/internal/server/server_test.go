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

func TestLogin(t *testing.T) {
	e := newTestEnv(t)
	e.public(http.MethodPost, "/api/auth/login", map[string]any{"password": "wrong"}).wantError(http.StatusUnauthorized, "Invalid password")
	e.public(http.MethodPost, "/api/auth/login", map[string]any{}).wantError(http.StatusUnauthorized, "Invalid password")
	e.public(http.MethodPost, "/api/auth/login", "{").wantError(http.StatusBadRequest, "Invalid JSON")

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

func TestAuthChecks(t *testing.T) {
	e := newTestEnv(t)
	e.public(http.MethodGet, "/api/auth/me", nil).wantError(http.StatusUnauthorized, "Not authenticated")
	e.public(http.MethodGet, "/api/students", nil).wantError(http.StatusUnauthorized, "Authentication required")

	expired, _ := auth.Sign(testJWTSecret, "admin", -time.Minute)
	otherSecret, _ := auth.Sign("other-secret", "admin", time.Hour)
	for name, token := range map[string]string{"expired": expired, "wrong secret": otherSecret, "garbage": "not-a-jwt"} {
		t.Run(name, func(t *testing.T) {
			e.cookie = &http.Cookie{Name: authCookie, Value: token}
			e.admin(http.MethodGet, "/api/students", nil).wantError(http.StatusForbidden, "Invalid or expired token")
			e.admin(http.MethodGet, "/api/auth/me", nil).wantError(http.StatusUnauthorized, "Not authenticated")
			// SSE streams are admin-only too.
			e.admin(http.MethodGet, "/api/sessions/events", nil).wantError(http.StatusForbidden, "Invalid or expired token")
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

func TestCORS(t *testing.T) {
	e := newTestEnv(t)
	req := httptest.NewRequest(http.MethodOptions, "/api/students", nil)
	req.Header.Set("Origin", "http://frontend.test")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d", rec.Code)
	}
	h := rec.Header()
	if h.Get("Access-Control-Allow-Origin") != "http://frontend.test" || h.Get("Access-Control-Allow-Credentials") != "true" ||
		h.Get("Access-Control-Allow-Headers") != "content-type" || !strings.Contains(h.Get("Access-Control-Allow-Methods"), "POST") {
		t.Fatalf("preflight headers = %v", h)
	}

	res := e.public(http.MethodGet, "/api/health", nil)
	if res.rec.Header().Get("Access-Control-Allow-Origin") != "http://frontend.test" {
		t.Fatal("CORS header missing on normal responses")
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

// --- public disciplines -----------------------------------------------------------------

func TestPublicDisciplines(t *testing.T) {
	f := newScheduleFixture(t, []string{"18:00"}, 1)
	juniors := f.groupIn("Juniors", 100) // with discipline "Juniors discipline"
	seniors := f.group("Seniors")
	inactive := f.discipline("Archived", juniors)
	f.exec("UPDATE disciplines SET active = 0 WHERE id = ?", inactive)
	f.student("A", juniors)
	manual := f.student("M", seniors)
	f.sendInvitations()
	f.invitation(f.sessionID, manual, f.timeslots[0], f.slots[0], 0, "invited")

	names := func(path string) string {
		var out []string
		for _, d := range f.public(http.MethodGet, path, nil).status(http.StatusOK).array() {
			out = append(out, d["name"].(string))
		}
		return strings.Join(out, ",")
	}
	if got := names("/api/public/disciplines"); got != "Juniors discipline,Seniors discipline" {
		t.Errorf("all active = %s", got)
	}
	if got := names("/api/public/disciplines/" + f.tokenOf("A")); got != "Juniors discipline" {
		t.Errorf("for auto-scheduled invitation = %s, want the invitation group's", got)
	}
	if got := names("/api/public/disciplines/" + f.tokenOf("M")); got != "Seniors discipline" {
		t.Errorf("for manual invitation = %s, want the student's group's", got)
	}
	if got := names("/api/public/disciplines/unknown"); got != "Juniors discipline,Seniors discipline" {
		t.Errorf("for unknown token = %s, want all active", got)
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

	f.invitationAction("A", "confirm", nil).status(http.StatusOK)
	ev, data := readEvent(t, sc)
	if ev != "invitation_updated" || !strings.Contains(data, `"status":"confirmed"`) {
		t.Fatalf("event %q data %s", ev, data)
	}
}
