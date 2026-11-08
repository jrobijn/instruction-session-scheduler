package server

import (
	"errors"
	"math"
	"testing"
)

// The helpers below mimic JavaScript semantics of the former TS backend; these tables pin them.

func TestTruthy(t *testing.T) {
	for _, tc := range []struct {
		v    any
		want bool
	}{
		{nil, false}, {false, false}, {true, true},
		{0.0, false}, {math.NaN(), false}, {2.5, true},
		{int64(0), false}, {int64(3), true}, {0, false}, {1, true},
		{"", false}, {"0", true},
		{map[string]any{}, true}, {[]any{}, true},
	} {
		if got := truthy(tc.v); got != tc.want {
			t.Errorf("truthy(%#v) = %v", tc.v, got)
		}
	}
}

func TestArg(t *testing.T) {
	for _, tc := range []struct {
		in, want any
	}{
		{3.0, int64(3)}, {-2.0, int64(-2)}, {2.5, 2.5}, {1e300, 1e300},
		{true, int64(1)}, {false, int64(0)},
		{"x", "x"}, {nil, nil},
		{map[string]any{"a": 1.0}, `{"a":1}`}, {[]any{1.0, "b"}, `[1,"b"]`},
	} {
		if got := arg(tc.in); got != tc.want {
			t.Errorf("arg(%#v) = %#v, want %#v", tc.in, got, tc.want)
		}
	}
	if got := args([]any{1.0, true}); got[0] != int64(1) || got[1] != int64(1) {
		t.Errorf("args = %#v", got)
	}
}

func TestJSString(t *testing.T) {
	for _, tc := range []struct {
		in   any
		want string
	}{
		{nil, "null"}, {"s", "s"}, {true, "true"}, {1.5, "1.5"}, {100.0, "100"}, {int64(7), "7"},
		{[]any{1.0, nil, "x"}, "1,,x"}, {map[string]any{}, "[object Object]"},
	} {
		if got := jsString(tc.in); got != tc.want {
			t.Errorf("jsString(%#v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestJSParseInt(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int
		ok   bool
	}{
		{"42", 42, true}, {" 7 ", 7, true}, {"12abc", 12, true}, {"-3", -3, true}, {"+4", 4, true},
		{"", 0, false}, {"abc", 0, false}, {"-", 0, false}, {"3.9", 3, true},
	} {
		if got, ok := jsParseInt(tc.in); got != tc.want || ok != tc.ok {
			t.Errorf("jsParseInt(%q) = %d, %v; want %d, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestJSNumberAndStrictEqual(t *testing.T) {
	for _, tc := range []struct {
		in   any
		want float64
	}{
		{3.0, 3}, {int64(2), 2}, {true, 1}, {false, 0}, {nil, 0}, {"", 0}, {" 5 ", 5}, {"1e2", 100},
	} {
		if got := jsNumber(tc.in); got != tc.want {
			t.Errorf("jsNumber(%#v) = %v, want %v", tc.in, got, tc.want)
		}
	}
	for _, in := range []any{"abc", map[string]any{}, []any{}} {
		if got := jsNumber(in); !math.IsNaN(got) {
			t.Errorf("jsNumber(%#v) = %v, want NaN", in, got)
		}
	}
}

func TestSessionSameTimetable(t *testing.T) {
	three := int64(3)
	for _, tc := range []struct {
		timetable *int64
		v         any
		want      bool
	}{
		{nil, nil, true}, {nil, 0.0, false}, {&three, nil, false},
		{&three, 3.0, true}, {&three, 4.0, false}, {&three, "3", false},
	} {
		if got := (Session{TimetableID: tc.timetable}).sameTimetable(tc.v); got != tc.want {
			t.Errorf("sameTimetable(%v, %#v) = %v", tc.timetable, tc.v, got)
		}
	}
}

func TestToInt64AndNumberKey(t *testing.T) {
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
	for _, tc := range []struct {
		in   any
		want int64
		ok   bool
	}{
		{int64(4), 4, true}, {4.0, 4, true}, {4.5, 0, false}, {"4", 0, false}, {nil, 0, false},
	} {
		if got, ok := numberKey(tc.in); got != tc.want || ok != tc.ok {
			t.Errorf("numberKey(%#v) = %d, %v", tc.in, got, ok)
		}
	}
}

func TestPreferredDays(t *testing.T) {
	all := "0|1|2|3|4|5|6"
	for _, tc := range []struct {
		student, club string
		want          []any // nil = covers all club days
	}{
		{all, all, nil},
		{"1|3", all, []any{1.0, 3.0}},
		{"1|3", "1|3", nil},          // every club day
		{"1|3|5", "1|3", nil},        // more than the club days
		{"1|6", "1|2|3", []any{1.0}}, // non-club days are dropped
		{"", all, nil},
		{" 1 |x", all, []any{1.0}}, // NaN entries are not club days
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
	if nilIfEmpty(nil) != nil || nilIfEmpty([]any{}) == nil {
		t.Error("nilIfEmpty")
	}
}

func TestSQLiteHelpers(t *testing.T) {
	err := errors.New("constraint failed: UNIQUE constraint failed: students.email (2067)")
	if got := sqliteMessage(err); got != "UNIQUE constraint failed: students.email" {
		t.Errorf("sqliteMessage = %q", got)
	}
	if got := sqliteMessage(errors.New("no such table: x")); got != "no such table: x" {
		t.Errorf("sqliteMessage passthrough = %q", got)
	}
	if !isUniqueErr(err) || isUniqueErr(nil) || isUniqueErr(errors.New("FOREIGN KEY constraint failed")) {
		t.Error("isUniqueErr")
	}
	if placeholders(0) != "" || placeholders(1) != "?" || placeholders(3) != "?,?,?" {
		t.Error("placeholders")
	}
}

func TestMarshalJS(t *testing.T) {
	if got := marshalJS(map[string]any{"html": "<b>&</b>"}); got != `{"html":"<b>&</b>"}` {
		t.Errorf("marshalJS = %s", got)
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
