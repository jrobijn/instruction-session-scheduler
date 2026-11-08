package server

import (
	"errors"
	"testing"
)

// The helpers below mimic JavaScript semantics of the former TS backend; these tables pin them.

func TestSessionSameTimetable(t *testing.T) {
	zero, three, four := int64(0), int64(3), int64(4)
	for _, tc := range []struct {
		timetable, id *int64
		want          bool
	}{
		{nil, nil, true}, {nil, &zero, false}, {&three, nil, false},
		{&three, &three, true}, {&three, &four, false},
	} {
		if got := (Session{TimetableID: tc.timetable}).sameTimetable(tc.id); got != tc.want {
			t.Errorf("sameTimetable(%v, %v) = %v", tc.timetable, tc.id, got)
		}
	}
}

func TestToInt64(t *testing.T) {
	for _, tc := range []struct {
		in   any
		want int64
	}{
		{int64(5), 5}, {5.9, 5}, {7, 7}, {"12", 12}, {"x", 0}, {nil, 0}, {true, 0},
	} {
		if got := toInt64(tc.in); got != tc.want {
			t.Errorf("toInt64(%#v) = %d", tc.in, got)
		}
	}
}

func TestPreferredDays(t *testing.T) {
	all := "0|1|2|3|4|5|6"
	for _, tc := range []struct {
		student, club string
		want          []int // nil = covers all club days
	}{
		{all, all, nil},
		{"1|3", all, []int{1, 3}},
		{"1|3", "1|3", nil},        // every club day
		{"1|3|5", "1|3", nil},      // more than the club days
		{"1|6", "1|2|3", []int{1}}, // non-club days are dropped
		{"", all, nil},
		{" 1 |x", all, []int{1}}, // entries that are not numbers are ignored
	} {
		got := preferredDays(tc.student, tc.club)
		if len(got) != len(tc.want) || (got == nil) != (tc.want == nil) {
			t.Errorf("preferredDays(%q, %q) = %v, want %v", tc.student, tc.club, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("preferredDays(%q, %q) = %v, want %v", tc.student, tc.club, got, tc.want)
			}
		}
	}
}

func TestSQLiteHelpers(t *testing.T) {
	err := errors.New("constraint failed: UNIQUE constraint failed: students.email (2067)")
	if !isUniqueErr(err) || isUniqueErr(nil) || isUniqueErr(errors.New("FOREIGN KEY constraint failed")) {
		t.Error("isUniqueErr")
	}
	if placeholders(0) != "" || placeholders(1) != "?" || placeholders(3) != "?,?,?" {
		t.Error("placeholders")
	}
}

func TestMarshalJS(t *testing.T) {
	if got := encodeJSON(map[string]any{"html": "<b>&</b>"}); got != `{"html":"<b>&</b>"}` {
		t.Errorf("encodeJSON = %s", got)
	}
}

func TestNewToken(t *testing.T) {
	a, b := newToken(), newToken()
	if a == b || len(a) != 36 || a[14] != '4' || (a[19] != '8' && a[19] != '9' && a[19] != 'a' && a[19] != 'b') {
		t.Fatalf("tokens %s, %s are not distinct UUID v4s", a, b)
	}
}

func TestIsValidTimeZone(t *testing.T) {
	for tz, want := range map[string]bool{"Europe/Amsterdam": true, "UTC": true, "": false, "Local": false, "Nope/Nope": false} {
		if got := isValidTimeZone(tz); got != want {
			t.Errorf("isValidTimeZone(%q) = %v", tz, got)
		}
	}
}
