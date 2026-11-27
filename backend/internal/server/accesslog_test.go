package server

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// syncBuffer is a bytes.Buffer safe for the stream handler's goroutine to write to.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.Write(p)
}

// take returns the lines logged since the last call.
func (b *syncBuffer) take() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	s := b.buf.String()
	b.buf.Reset()
	return s
}

func captureLog(t *testing.T) *syncBuffer {
	t.Helper()
	var b syncBuffer
	out, flags := log.Writer(), log.Flags()
	log.SetOutput(&b)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(out)
		log.SetFlags(flags)
	})

	return &b
}

func TestAccessLog(t *testing.T) {
	f, _ := invitedPair(t)
	logs := captureLog(t)
	token := f.tokenOf("A")

	f.public(http.MethodGet, "/api/invitations/"+token+"?x=1", nil).status(http.StatusOK)
	got := logs.take()
	if !strings.HasPrefix(got, "api: 192.0.2.1 GET /api/invitations/{token} 200 ") {
		t.Fatalf("log = %q", got)
	}

	if strings.Contains(got, token) || strings.Contains(got, "x=1") {
		t.Fatalf("log leaks the token or query: %q", got)
	}

	f.public(http.MethodGet, "/api/students", nil).status(http.StatusUnauthorized)
	if got := logs.take(); !strings.HasPrefix(got, "api: 192.0.2.1 GET /api/students 401 ") {
		t.Fatalf("log = %q", got)
	}

	f.admin(http.MethodPost, "/api/no-such-route/"+token, nil).status(http.StatusNotFound)
	if got := logs.take(); !strings.HasPrefix(got, "api: 192.0.2.1 POST (no route) 404 ") {
		t.Fatalf("log = %q", got)
	}

	// Forwarding headers come from the client, so they are ignored.
	req := httptest.NewRequest(http.MethodGet, "/api/students", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	f.handler.ServeHTTP(httptest.NewRecorder(), req)
	if got := logs.take(); !strings.HasPrefix(got, "api: 192.0.2.1 GET /api/students 401 ") {
		t.Fatalf("log = %q", got)
	}

	// Health checks and static files are not logged.
	f.public(http.MethodGet, "/api/health", nil).status(http.StatusOK)
	f.public(http.MethodGet, "/sessions/3", nil)
	if got := logs.take(); got != "" {
		t.Fatalf("log = %q", got)
	}

	// Streams are logged once, when they open.
	f.openStream("/api/invitations/"+token+"/events", nil)
	got = logs.take()
	if !strings.HasPrefix(got, "api: 127.0.0.1 GET /api/invitations/{token}/events 200 ") || !strings.HasSuffix(got, " stream opened\n") {
		t.Fatalf("log = %q", got)
	}
}

func TestAccessLogPathValues(t *testing.T) {
	e := newTestEnv(t)
	logs := captureLog(t)

	e.admin(http.MethodDelete, "/api/groups/7/members/12", nil)
	if got := logs.take(); !strings.HasPrefix(got, "api: 192.0.2.1 DELETE /api/groups/{id}/members/{studentId} id=7 studentId=12 404 ") {
		t.Fatalf("log = %q", got)
	}

	// Values from the client that could break the line are quoted.
	e.admin(http.MethodGet, "/api/students/1%0Aapi:%20forged", nil)
	if got := logs.take(); !strings.HasPrefix(got, `api: 192.0.2.1 GET /api/students/{id} id="1\napi: forged" 404 `) {
		t.Fatalf("log = %q", got)
	}
}

func TestAccessLogPanic(t *testing.T) {
	e := newTestEnv(t)
	e.srv.mux.HandleFunc("GET /api/test-panic/{id}", func(http.ResponseWriter, *http.Request) { panic("boom") })
	logs := captureLog(t)

	// net/http recovers the panic in a real server; here it reaches the test.
	func() {
		defer func() {
			if p := recover(); p != "boom" {
				t.Fatalf("recovered %v, want the handler's panic", p)
			}
		}()

		e.public(http.MethodGet, "/api/test-panic/3", nil)
	}()

	if got := logs.take(); !strings.HasPrefix(got, "api: 192.0.2.1 GET /api/test-panic/{id} id=3 panic ") {
		t.Fatalf("log = %q", got)
	}
}
