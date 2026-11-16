package httpx

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJSONHelpers(t *testing.T) {
	rec := httptest.NewRecorder()
	Error(rec, http.StatusTeapot, "nope")
	if rec.Code != http.StatusTeapot || rec.Body.String() != "{\"error\":\"nope\"}\n" ||
		rec.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("Error wrote %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	rec = httptest.NewRecorder()
	Success(rec)
	if rec.Code != http.StatusOK || rec.Body.String() != "{\"success\":true}\n" {
		t.Fatalf("Success wrote %d %q", rec.Code, rec.Body)
	}
}

func TestDecode(t *testing.T) {
	var v map[string]any
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"a":1}`))
	if err := Decode(req, &v); err != nil || v["a"] != 1.0 {
		t.Fatalf("Decode = %v, %v", v, err)
	}

	// An empty body leaves the value untouched.
	v = map[string]any{"kept": true}
	if err := Decode(httptest.NewRequest(http.MethodPost, "/", nil), &v); err != nil || v["kept"] != true {
		t.Fatalf("empty body: %v, %v", v, err)
	}
	if err := Decode(httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{")), &v); err == nil {
		t.Fatal("malformed JSON accepted")
	}
	big := `{"a":"` + strings.Repeat("x", 1<<20) + `"}`
	if err := Decode(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(big)), &v); err == nil {
		t.Fatal("body over 1 MiB accepted")
	}
}
