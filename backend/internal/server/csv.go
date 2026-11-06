package server

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

// These helpers reproduce the hand-written CSV handling of the TS routes exactly, so
// imports and exports behave identically (encoding/csv is stricter about quoting).

func escapeCSVField(v any) string {
	var s string
	if v != nil {
		s = jsString(v)
	}
	if strings.ContainsAny(s, ",\"\n") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func csvRow(values ...any) string {
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = escapeCSVField(v)
	}
	return strings.Join(parts, ",")
}

func writeCSV(w http.ResponseWriter, filename, header string, rows []string) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Write([]byte(strings.Join(append([]string{header}, rows...), "\n")))
}

var lineSplit = regexp.MustCompile(`\r?\n`)

// csvLines splits on newlines and drops blank lines.
func csvLines(csv string) []string {
	var out []string
	for _, l := range lineSplit.Split(csv, -1) {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

// csvHeader lowercases, trims and strips one pair of surrounding quotes from each column name.
func csvHeader(line string) []string {
	cols := strings.Split(strings.ToLower(line), ",")
	for i, c := range cols {
		c = strings.TrimSpace(c)
		c = strings.TrimPrefix(c, `"`)
		c = strings.TrimSuffix(c, `"`)
		cols[i] = c
	}
	return cols
}

func indexOf(cols []string, name string) int {
	for i, c := range cols {
		if c == name {
			return i
		}
	}
	return -1
}

func parseCSVLine(line string) []string {
	var fields []string
	var cur strings.Builder
	inQuotes := false
	for i := 0; i < len(line); i++ {
		ch := line[i]
		if inQuotes {
			switch {
			case ch == '"' && i+1 < len(line) && line[i+1] == '"':
				cur.WriteByte('"')
				i++
			case ch == '"':
				inQuotes = false
			default:
				cur.WriteByte(ch)
			}
		} else {
			switch ch {
			case '"':
				inQuotes = true
			case ',':
				fields = append(fields, strings.TrimSpace(cur.String()))
				cur.Reset()
			default:
				cur.WriteByte(ch)
			}
		}
	}
	return append(fields, strings.TrimSpace(cur.String()))
}

// field returns fields[idx] trimmed, or "" when the index is out of range or negative.
func field(fields []string, idx int) string {
	if idx < 0 || idx >= len(fields) {
		return ""
	}
	return strings.TrimSpace(fields[idx])
}

type importResult struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors"`
}

// readCSVImport validates the {csv} body shared by all import endpoints. It returns the
// non-blank lines, or writes a 400 and returns ok=false.
func readCSVImport(w http.ResponseWriter, r *http.Request) ([]string, bool) {
	b, ok := decodeBody(w, r)
	if !ok {
		return nil, false
	}
	csv, isString := b["csv"].(string)
	if !isString || csv == "" {
		httpx.Error(w, http.StatusBadRequest, "CSV data is required")
		return nil, false
	}
	lines := csvLines(csv)
	if len(lines) < 2 {
		httpx.Error(w, http.StatusBadRequest, "CSV must have a header row and at least one data row")
		return nil, false
	}
	return lines, true
}
