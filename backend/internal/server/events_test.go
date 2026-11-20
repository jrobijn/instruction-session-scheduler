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
