package server

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestParseCSVImport(t *testing.T) {
	data := "\uFEFF \"First_Name\",EMAIL \r\n" +
		"Ann , a@x.nl\n" +
		"\n" +
		"  ,  \n" +
		"\"Smith, \"\"Jr.\"\"\",\"multi\nline\"\n" +
		"short\n"
	in, err := parseCSVImport(data)
	if err != nil {
		t.Fatal(err)
	}
	if !in.has("first_name", "email") || in.has("last_name") {
		t.Errorf("cols = %v", in.cols)
	}

	type row struct {
		line         int
		first, email string
	}

	var got []row
	for _, r := range in.rows {
		got = append(got, row{r.line, r.get("first_name"), r.get("email")})
	}

	want := []row{{2, "Ann", "a@x.nl"}, {5, `Smith, "Jr."`, "multi\nline"}, {7, "short", ""}}
	if !slices.Equal(got, want) {
		t.Errorf("rows = %+v, want %+v", got, want)
	}
}

func TestCSVExportRoundTrip(t *testing.T) {
	rec := httptest.NewRecorder()
	values := []string{"Smith, Jr.", `the "best"`, " padded", "two\nlines", ""}
	if err := writeCSV(rec, "x.csv", []string{"a", "b", "c", "d", "e"}, [][]string{values}); err != nil {
		t.Fatal(err)
	}

	in, err := parseCSVImport(rec.Body.String())
	if err != nil || len(in.rows) != 1 {
		t.Fatalf("parse: %v, %d rows", err, len(in.rows))
	}
	for i, col := range []string{"a", "b", "c", "d", "e"} {
		// get trims, so " padded" comes back as "padded"
		if got, want := in.rows[0].get(col), strings.TrimSpace(values[i]); got != want {
			t.Errorf("%s = %q, want %q", col, got, want)
		}
	}
}

func TestCSVImportValidation(t *testing.T) {
	e := newTestEnv(t)
	for _, path := range []string{"/api/students/import", "/api/instructors/import", "/api/groups/import", "/api/disciplines/import"} {
		e.admin(http.MethodPost, path, map[string]any{}).wantError(http.StatusBadRequest, "CSV data is required")
		e.admin(http.MethodPost, path, map[string]any{"csv": 5}).wantError(http.StatusBadRequest, "Invalid JSON body")
		e.admin(http.MethodPost, path, map[string]any{"csv": "name\n\n"}).
			wantError(http.StatusBadRequest, "CSV must have a header row and at least one data row")
		e.admin(http.MethodPost, path, map[string]any{"csv": "name\n\"a\"\"b"}).status(http.StatusBadRequest)
	}
}

func TestCSVExportHeaders(t *testing.T) {
	e := newTestEnv(t)
	res := e.admin(http.MethodGet, "/api/groups/export", nil).status(http.StatusOK)
	if ct := res.rec.Header().Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cd := res.rec.Header().Get("Content-Disposition"); cd != `attachment; filename="groups.csv"` {
		t.Errorf("Content-Disposition = %q", cd)
	}
	if !strings.HasPrefix(string(res.Body), "name,is_default,active") {
		t.Errorf("body = %q", res.Body)
	}
}
