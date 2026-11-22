package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// decode reads a JSON request body of at most 1 MiB into a T (usually a struct with json
// tags). If the body is missing, malformed, too large or a field has the wrong type it returns
// an "Invalid JSON body" error meant for the client, as a 400. Unknown fields are ignored.
//
// Conventions for request structs: required values are plain types, validated with
// == "" / == 0; values that may be left out of a partial update are pointers, which bind as
// NULL so `col = COALESCE(?, col)` keeps the stored value.
func decode[T any](r *http.Request) (T, error) {
	var v T
	if err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(&v); err != nil {
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

// pathID parses the integer path parameter name, reporting whether it is one. A value that
// isn't an integer can't match any row, so callers answer it with the same 404 as an id
// that doesn't exist.
func pathID(r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	return id, err == nil
}

// encodeJSON encodes v for storage (decision logs) without escaping <, > and &.
func encodeJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
	return strings.TrimSuffix(buf.String(), "\n")
}
