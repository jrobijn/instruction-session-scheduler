// Package httpx holds small HTTP helpers shared by all handlers.
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
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

// PathInt64 parses a numeric path value; ok is false if it is missing or not a number.
func PathInt64(r *http.Request, name string) (int64, bool) {
	n, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	return n, err == nil
}

// CORS mirrors the `cors({ origin, credentials: true })` configuration of the TS backend.
func CORS(origin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Credentials", "true")
		h.Add("Vary", "Origin")
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
			if reqHeaders := r.Header.Get("Access-Control-Request-Headers"); reqHeaders != "" {
				h.Set("Access-Control-Allow-Headers", reqHeaders)
				h.Add("Vary", "Access-Control-Request-Headers")
			}
			h.Set("Content-Length", "0")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
