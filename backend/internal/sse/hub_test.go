package sse

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func (h *Hub) subscribers(channel string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients[channel])
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func subscribe(t *testing.T, srv *httptest.Server, channel string) (*bufio.Scanner, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/?channel="+channel, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.Header.Get("Content-Type") != "text/event-stream" || resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("headers = %v", resp.Header)
	}
	return bufio.NewScanner(resp.Body), cancel
}

func TestHubDeliversToChannelSubscribers(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.Serve(w, r, r.URL.Query().Get("channel"))
	}))
	defer srv.Close()

	a, cancelA := subscribe(t, srv, "a")
	defer cancelA()
	b, cancelB := subscribe(t, srv, "b")
	defer cancelB()
	waitFor(t, func() bool { return h.subscribers("a") == 1 && h.subscribers("b") == 1 })

	h.Broadcast("a", "hello", map[string]int{"n": 1})
	h.BroadcastSession(7, "ignored", nil) // other channel
	h.Broadcast("b", "bye", "x")

	read := func(sc *bufio.Scanner) []string {
		var lines []string
		for sc.Scan() {
			if l := sc.Text(); l != "" {
				lines = append(lines, l)
				if strings.HasPrefix(l, "data:") {
					return lines
				}
			}
		}
		return lines
	}
	if got := strings.Join(read(a), "|"); got != `event: hello|data: {"n":1}` {
		t.Errorf("a got %q", got)
	}
	if got := strings.Join(read(b), "|"); got != `event: bye|data: "x"` {
		t.Errorf("b got %q", got)
	}

	cancelA()
	waitFor(t, func() bool { return h.subscribers("a") == 0 })
}

func TestBroadcastWithoutSubscribersOrToSlowClient(t *testing.T) {
	h := NewHub()
	h.Broadcast("nobody", "event", map[string]int{}) // must not block or panic

	// A client that never reads must not block broadcasters once its buffer is full.
	c := make(client, 1)
	h.subscribe("slow", c)
	done := make(chan struct{})
	go func() {
		for range 10 {
			h.BroadcastSessionsList("x", 1)
			h.Broadcast("slow", "x", 1)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("broadcast blocked on a slow client")
	}
	h.unsubscribe("slow", c)
	if h.subscribers("slow") != 0 {
		t.Fatal("unsubscribe left the client registered")
	}
}

func TestBroadcastUnmarshalableDataIsDropped(t *testing.T) {
	h := NewHub()
	c := make(client, 1)
	h.subscribe("ch", c)
	h.Broadcast("ch", "bad", make(chan int))
	select {
	case msg := <-c:
		t.Fatalf("got %q", msg)
	default:
	}
}
