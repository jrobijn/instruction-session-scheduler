package server

import (
	"bytes"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// handlerFunc is an http.HandlerFunc that may return an error. An *httpx.StatusError (from
// httpx.NotFound, httpx.BadRequest, ...) becomes that response; any other error is
// unexpected and becomes a 500 (like an uncaught exception in an Express handler). A
// handler that returns an error must not have written a response.
type handlerFunc func(w http.ResponseWriter, r *http.Request) error

func (s *Server) wrap(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if err := fn(w, r); err != nil {
			s.writeError(w, err)
		}
	}
}

// writeError writes err as its *httpx.StatusError response, or as a 500.
func (s *Server) writeError(w http.ResponseWriter, err error) {
	if !httpx.WriteError(w, err) {
		s.internalError(w, err)
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

// decode reads a JSON request body into a T (usually a struct with json tags), returning a
// 400 error if it is malformed or a field has the wrong type. Unknown fields are ignored
// and an empty body leaves T at its zero value.
//
// Conventions for request structs: required values are plain types, validated with
// == "" / == 0; values that may be left out of a partial update are pointers, which bind as
// NULL so `col = COALESCE(?, col)` keeps the stored value.
func decode[T any](r *http.Request) (T, error) {
	var v T
	if err := httpx.Decode(r, &v); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			return v, httpx.BadRequest("Invalid value for " + typeErr.Field)
		}
		return v, httpx.BadRequest("Invalid JSON body")
	}
	return v, nil
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

// isUniqueErr reports whether err is a UNIQUE (or PRIMARY KEY) violation of exactly the
// constraint over columns, given as "table.column" in declaration order, e.g.
// isUniqueErr(err, "disciplines.name"). Violations of any other constraint return false,
// so they surface as internal errors rather than a misleading conflict message.
func isUniqueErr(err error, columns ...string) bool {
	var se *sqlite.Error
	if !errors.As(err, &se) {
		return false
	}
	if code := se.Code(); code != sqlite3.SQLITE_CONSTRAINT_UNIQUE && code != sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY {
		return false
	}
	// The message reads "... UNIQUE constraint failed: t.a, t.b (2067)".
	_, failed, ok := strings.Cut(se.Error(), "UNIQUE constraint failed: ")
	if !ok {
		return false
	}
	failed = strings.TrimSuffix(failed, fmt.Sprintf(" (%d)", se.Code()))
	return failed == strings.Join(columns, ", ")
}

func changes(res sql.Result) int64 {
	n, _ := res.RowsAffected()
	return n
}

// exists reports whether query returns at least one row.
func (s *Server) exists(query string, a ...any) bool {
	var one any
	return s.db.QueryRow(query, a...).Scan(&one) == nil
}

// pathID parses the integer path parameter name. A value that isn't an integer can't match
// any row, so it gets the same 404 error (with notFound as the message) as an id that
// doesn't exist.
func pathID(r *http.Request, name, notFound string) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil {
		return 0, httpx.NotFound(notFound)
	}
	return id, nil
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

// newToken returns a random UUID v4, like crypto.randomUUID().
func newToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (s *Server) clubName() string    { return db.Setting(s.db, "club_name", "Sports Club") }
func (s *Server) emailLocale() string { return db.Setting(s.db, "email_locale", "en") }

// encodeJSON encodes v for storage (decision logs) without escaping <, > and &.
func encodeJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
	return strings.TrimSuffix(buf.String(), "\n")
}

// nonEmpty returns nil for "", so the value encodes as null (like `value || null`).
func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
