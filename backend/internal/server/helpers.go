package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

// handlerFunc is an http.HandlerFunc that may return an unexpected error, which is turned
// into a 500 response (like an uncaught exception in an Express handler).
type handlerFunc func(w http.ResponseWriter, r *http.Request) error

func (s *Server) wrap(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if err := fn(w, r); err != nil {
			s.internalError(w, err)
		}
	}
}

// adminRoute registers an authenticated route.
func (s *Server) adminRoute(pattern string, fn handlerFunc) {
	s.mux.HandleFunc(pattern, s.admin(s.wrap(fn)))
}

// publicRoute registers an unauthenticated route.
func (s *Server) publicRoute(pattern string, fn handlerFunc) {
	s.mux.HandleFunc(pattern, s.wrap(fn))
}

// decode reads a JSON request body into a T (usually a struct with json tags) and writes a
// 400 if it is malformed or a field has the wrong type. Unknown fields are ignored and an
// empty body leaves T at its zero value.
//
// Conventions for request structs: required values are plain types, validated with
// == "" / == 0; values that may be left out of a partial update are pointers, which bind as
// NULL so `col = COALESCE(?, col)` keeps the stored value.
func decode[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var v T
	if err := httpx.Decode(r, &v); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			httpx.Error(w, http.StatusBadRequest, "Invalid value for "+typeErr.Field)
		} else {
			httpx.Error(w, http.StatusBadRequest, "Invalid JSON body")
		}
		return v, false
	}
	return v, true
}

// optional is a request field that tells a missing key (Set false) from null (Set true,
// Value nil). Use it only where null means something other than "leave unchanged".
type optional[T any] struct {
	Set   bool
	Value *T
}

func (o *optional[T]) UnmarshalJSON(data []byte) error {
	o.Set = true
	if string(data) == "null" {
		o.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// deref returns *p, or "" for a NULL column.
func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func isUniqueErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint")
}

func lastID(res sql.Result) int64 {
	id, _ := res.LastInsertId()
	return id
}

func changes(res sql.Result) int64 {
	n, _ := res.RowsAffected()
	return n
}

// placeholders returns "?,?,?" for n values (n >= 1).
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}

// isValidTimeZone matches the Intl.DateTimeFormat check in expiryTimers.ts.
func isValidTimeZone(tz string) bool {
	if tz == "" || tz == "Local" {
		return false
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

func logf(format string, a ...any) { log.Printf(format, a...) }
