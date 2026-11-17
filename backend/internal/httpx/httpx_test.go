package httpx

import (
	"net/http"
	"net/http/httptest"
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
