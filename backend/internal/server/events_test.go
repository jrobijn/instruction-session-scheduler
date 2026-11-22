package server

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// openStream subscribes to an SSE stream on a real test server and returns a scanner over
// it once the subscription is in place. cookie may be nil for public streams. The stream
// is closed before the server, because closing the server waits for open requests.
func (e *testEnv) openStream(path string, cookie *http.Cookie) *bufio.Scanner {
	e.t.Helper()
	ts := httptest.NewServer(e.handler)
	e.t.Cleanup(ts.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	e.t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}

	e.t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		e.t.Fatalf("GET %s = %d", path, resp.StatusCode)
	}

	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		e.t.Fatalf("Content-Type = %q", ct)
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Scan() // the initial blank line confirms the subscription is in place
	return sc
}

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
	f.public(http.MethodGet, "/api/invitations/unknown/events", nil).wantError(http.StatusNotFound, "Not found")

	sc := f.openStream("/api/invitations/"+f.tokenOf("A")+"/events", nil)
	f.invitationAction("A", "decline", nil).status(http.StatusOK)
	ev, data := readEvent(t, sc)
	if ev != "invitation_updated" || data != `{"status":"declined"}` {
		t.Fatalf("event %q data %s", ev, data)
	}
}

func TestSessionEventsStream(t *testing.T) {
	f, _ := invitedPair(t)
	f.admin(http.MethodGet, "/api/sessions/abc/events", nil).wantError(http.StatusNotFound, "Not found")

	sc := f.openStream(sessionPath(f.sessionID, "events"), f.cookie)
	f.invitationAction("A", "confirm", map[string]any{}).status(http.StatusOK)
	ev, data := readEvent(t, sc)
	if ev != "invitation_updated" || !strings.Contains(data, `"status":"confirmed"`) {
		t.Fatalf("event %q data %s", ev, data)
	}
}

func TestSessionsListEventsStream(t *testing.T) {
	f, _ := invitedPair(t)

	sc := f.openStream("/api/sessions/events", f.cookie)
	f.invitationAction("A", "confirm", map[string]any{}).status(http.StatusOK)
	ev, data := readEvent(t, sc)
	if ev != "session_counts_updated" || !strings.Contains(data, `"confirmed_count":1`) {
		t.Fatalf("event %q data %s", ev, data)
	}
}

func TestNotificationsEventsStream(t *testing.T) {
	f, _ := invitedPair(t)

	sc := f.openStream("/api/notifications/events", f.cookie)
	f.expire(toInt64(f.invitationOf("A")["id"]))
	ev, data := readEvent(t, sc)
	if ev != "new_notification" || !strings.Contains(data, `"type":"invitation_expired"`) || !strings.Contains(data, `"unread_count":1`) {
		t.Fatalf("event %q data %s", ev, data)
	}
}
