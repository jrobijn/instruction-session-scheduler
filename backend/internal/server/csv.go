package server

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// writeCSV sends header and rows as a CSV file download.
func writeCSV(w http.ResponseWriter, filename string, header []string, rows [][]string) error {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	cw := csv.NewWriter(w)
	cw.Write(header)
	cw.WriteAll(rows) // flushes
	return cw.Error()
}

// csvImport is a parsed CSV upload: one entry per non-blank data row.
type csvImport struct {
	cols map[string]int // lowercased, trimmed header name -> field index
	rows []csvRecord
}

type csvRecord struct {
	line   int // line number in the uploaded file, for error messages
	cols   map[string]int
	fields []string
}

// has reports whether the header contains all of the named columns.
func (c csvImport) has(names ...string) bool {
	for _, n := range names {
		if _, ok := c.cols[n]; !ok {
			return false
		}
	}
	return true
}

// get returns the trimmed value of the named column, or "" when the column is absent or
// the row is too short.
func (r csvRecord) get(col string) string {
	i, ok := r.cols[col]
	if !ok || i >= len(r.fields) {
		return ""
	}
	return strings.TrimSpace(r.fields[i])
}

func parseCSVImport(data string) (csvImport, error) {
	rd := csv.NewReader(strings.NewReader(strings.TrimPrefix(data, "\uFEFF")))
	rd.FieldsPerRecord = -1 // rows may be shorter or longer than the header
	rd.TrimLeadingSpace = true

	in := csvImport{cols: map[string]int{}}
	first := true
	for {
		rec, err := rd.Read()
		if errors.Is(err, io.EOF) {
			return in, nil
		}
		if err != nil {
			return in, err
		}
		if first {
			for i, c := range rec {
				in.cols[strings.ToLower(strings.TrimSpace(c))] = i
			}
			first = false
			continue
		}
		if strings.TrimSpace(strings.Join(rec, "")) == "" {
			continue
		}
		line, _ := rd.FieldPos(0)
		in.rows = append(in.rows, csvRecord{line: line, cols: in.cols, fields: rec})
	}
}

type importResult struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors"`
}

// skip counts row as skipped and records why.
func (res *importResult) skip(row csvRecord, format string, args ...any) {
	res.Errors = append(res.Errors, fmt.Sprintf("Row %d: ", row.line)+fmt.Sprintf(format, args...))
	res.Skipped++
}

// readCSVImport decodes and parses the {csv} body shared by all import endpoints, returning
// an error whose message is meant for the client, as a 400, if it is missing or malformed.
func readCSVImport(r *http.Request) (csvImport, error) {
	type request struct {
		CSV string `json:"csv"`
	}
	body, err := decode[request](r)
	if err != nil {
		return csvImport{}, err
	}
	if body.CSV == "" {
		return csvImport{}, errors.New("CSV data is required")
	}
	in, err := parseCSVImport(body.CSV)
	if err != nil {
		return csvImport{}, errors.New("Invalid CSV: " + err.Error())
	}
	if len(in.rows) == 0 {
		return csvImport{}, errors.New("CSV must have a header row and at least one data row")
	}
	return in, nil
}
