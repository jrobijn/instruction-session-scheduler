package server

import (
	"database/sql"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
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

// body is a decoded JSON request body, read the way Express handlers destructure req.body:
// missing keys are nil and values keep their dynamic JSON type.
type body map[string]any

func readBody(r *http.Request) (body, error) {
	var v any
	if err := httpx.Decode(r, &v); err != nil {
		return nil, err
	}
	if m, ok := v.(map[string]any); ok {
		return m, nil
	}
	return body{}, nil
}

// decodeBody reads the body and writes a 400 on malformed JSON (express.json() behaviour).
func decodeBody(w http.ResponseWriter, r *http.Request) (body, bool) {
	b, err := readBody(r)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "Invalid JSON body")
		return nil, false
	}
	return b, true
}

// truthy implements JavaScript truthiness for JSON and SQLite values.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int64:
		return x != 0
	case int:
		return x != 0
	case string:
		return x != ""
	default:
		return true
	}
}

// arg converts a decoded JSON value into something the SQLite driver binds the way
// better-sqlite3 does: integral numbers become integers.
func arg(v any) any {
	switch x := v.(type) {
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 1<<53 {
			return int64(x)
		}
		return x
	case bool:
		if x {
			return int64(1)
		}
		return int64(0)
	case map[string]any, []any:
		// better-sqlite3 refuses to bind objects; store their JSON instead of failing.
		b, _ := json.Marshal(x)
		return string(b)
	default:
		return v
	}
}

// jsString mimics JavaScript's String(value) for JSON values.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(x, 10)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// jsParseInt mimics parseInt(s, 10): leading digits are parsed, ok is false if there are none.
func jsParseInt(s string) (int, bool) {
	s = strings.TrimSpace(s)
	end := 0
	if end < len(s) && (s[end] == '-' || s[end] == '+') {
		end++
	}
	start := end
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == start {
		return 0, false
	}
	n, err := strconv.Atoi(s[:end])
	return n, err == nil
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

var sqliteCodeSuffix = regexp.MustCompile(` \(\d+\)$`)

// sqliteMessage strips modernc's "constraint failed: ... (2067)" wrapping so error texts
// match better-sqlite3's (e.g. "UNIQUE constraint failed: students.email").
func sqliteMessage(err error) string {
	msg := sqliteCodeSuffix.ReplaceAllString(err.Error(), "")
	const prefix = "constraint failed: "
	if rest, ok := strings.CutPrefix(msg, prefix); ok && strings.Contains(rest, "constraint failed") {
		msg = rest
	}
	return msg
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

func args(values []any) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = arg(v)
	}
	return out
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
