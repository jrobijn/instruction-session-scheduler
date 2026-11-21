package server

import "testing"

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
