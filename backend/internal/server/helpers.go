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

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// decode reads a JSON request body into a T (usually a struct with json tags). If the body
// is malformed or a field has the wrong type it returns an error whose message is meant for
// the client, as a 400. Unknown fields are ignored and an empty body leaves T at its zero
// value.
//
// Conventions for request structs: required values are plain types, validated with
// == "" / == 0; values that may be left out of a partial update are pointers, which bind as
// NULL so `col = COALESCE(?, col)` keeps the stored value.
func decode[T any](r *http.Request) (T, error) {
	var v T
	if err := httpx.Decode(r, &v); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			return v, errors.New("Invalid value for " + typeErr.Field)
		}
		return v, errors.New("Invalid JSON body")
	}
	return v, nil
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

// pathID parses the integer path parameter name, reporting whether it is one. A value that
// isn't an integer can't match any row, so callers answer it with the same 404 as an id
// that doesn't exist.
func pathID(r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	return id, err == nil
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
