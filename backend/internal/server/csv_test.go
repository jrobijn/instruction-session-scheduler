package server

import (
	"net/http"
	"slices"
	"strings"
	"testing"
)

func TestEscapeCSVField(t *testing.T) {
	for _, tc := range []struct {
		in   any
		want string
	}{
		{"plain", "plain"},
		{"a,b", `"a,b"`},
		{`say "hi"`, `"say ""hi"""`},
		{"two\nlines", "\"two\nlines\""},
		{nil, ""},
		{int64(3), "3"},
		{1.5, "1.5"},
	} {
		if got := escapeCSVField(tc.in); got != tc.want {
			t.Errorf("escapeCSVField(%#v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestParseCSVLine(t *testing.T) {
	for _, tc := range []struct {
		line string
		want []string
	}{
		{"a,b,c", []string{"a", "b", "c"}},
		{" a , b ", []string{"a", "b"}},
		{`"a,b",c`, []string{"a,b", "c"}},
		{`"say ""hi""",x`, []string{`say "hi"`, "x"}},
		{"a,,c", []string{"a", "", "c"}},
		{"a,", []string{"a", ""}},
		{"", []string{""}},
		{`"unterminated,x`, []string{"unterminated,x"}},
	} {
		if got := parseCSVLine(tc.line); !slices.Equal(got, tc.want) {
			t.Errorf("parseCSVLine(%q) = %q, want %q", tc.line, got, tc.want)
		}
	}
}

func TestCSVRoundTrip(t *testing.T) {
	values := []any{"Smith, Jr.", `the "best"`, "plain", ""}
	got := parseCSVLine(csvRow(values...))
	for i, v := range values {
		if got[i] != v {
			t.Errorf("field %d = %q, want %q", i, got[i], v)
		}
	}
}

func TestCSVLinesAndHeader(t *testing.T) {
	if got := csvLines("a\r\nb\n\n  \nc"); !slices.Equal(got, []string{"a", "b", "c"}) {
		t.Errorf("csvLines = %q", got)
	}
	if got := csvHeader(` "First_Name" ,EMAIL`); !slices.Equal(got, []string{"first_name", "email"}) {
		t.Errorf("csvHeader = %q", got)
	}
	if indexOf([]string{"a", "b"}, "b") != 1 || indexOf([]string{"a"}, "x") != -1 {
		t.Error("indexOf")
	}
	if field([]string{" x "}, 0) != "x" || field([]string{"x"}, 3) != "" || field([]string{"x"}, -1) != "" {
		t.Error("field")
	}
}

func TestCSVImportValidation(t *testing.T) {
	e := newTestEnv(t)
	for _, path := range []string{"/api/students/import", "/api/instructors/import", "/api/groups/import", "/api/disciplines/import"} {
		e.admin(http.MethodPost, path, map[string]any{}).wantError(http.StatusBadRequest, "CSV data is required")
		e.admin(http.MethodPost, path, map[string]any{"csv": 5}).wantError(http.StatusBadRequest, "Invalid value for csv")
		e.admin(http.MethodPost, path, map[string]any{"csv": "name\n\n"}).
			wantError(http.StatusBadRequest, "CSV must have a header row and at least one data row")
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
