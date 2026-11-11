// Package httpx holds small HTTP helpers shared by all handlers.
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
)

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("httpx: encode response: %v", err)
	}
}

func OK(w http.ResponseWriter, v any) { JSON(w, http.StatusOK, v) }

func Error(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]string{"error": msg})
}

// Success writes the {"success": true} body many endpoints return.
func Success(w http.ResponseWriter) { OK(w, map[string]bool{"success": true}) }

// Decode parses a JSON request body into v. An empty body leaves v untouched, mirroring
// express.json() which yields {} for requests without a body.
func Decode(r *http.Request, v any) error {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
