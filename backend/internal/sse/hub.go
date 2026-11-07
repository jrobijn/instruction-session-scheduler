// Package sse is a channel-keyed Server-Sent Events broadcaster.
package sse

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
)

type client chan []byte

type Hub struct {
	mu      sync.Mutex
	clients map[string]map[client]struct{}
}

func NewHub() *Hub {
	return &Hub{clients: make(map[string]map[client]struct{})}
}

// Serve writes SSE headers and streams events for channel until the request is cancelled.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, channel string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("\n"))
	flusher.Flush()

	c := make(client, 16)
	h.subscribe(channel, c)
	defer h.unsubscribe(channel, c)

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-c:
			if _, err := w.Write(msg); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Hub) subscribe(channel string, c client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.clients[channel]
	if !ok {
		set = make(map[client]struct{})
		h.clients[channel] = set
	}
	set[c] = struct{}{}
}

func (h *Hub) unsubscribe(channel string, c client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.clients[channel]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.clients, channel)
		}
	}
}

func (h *Hub) Broadcast(channel, event string, data any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.clients[channel]
	if len(set) == 0 {
		return
	}
	body, err := json.Marshal(data)
	if err != nil {
		log.Printf("sse: marshal %s/%s: %v", channel, event, err)
		return
	}
	payload := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, body))
	for c := range set {
		select {
		case c <- payload:
		default: // slow client: drop the event rather than block every broadcaster
		}
	}
}

func (h *Hub) BroadcastSession(sessionID int64, event string, data any) {
	h.Broadcast("session:"+strconv.FormatInt(sessionID, 10), event, data)
}

func (h *Hub) BroadcastSessionsList(event string, data any) {
	h.Broadcast("sessions-list", event, data)
}
