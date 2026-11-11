package scheduling

import "testing"

func TestMatcher(t *testing.T) {
	timeslots := []Timeslot{{ID: 10, Capacity: 1}, {ID: 20, Capacity: 1}, {ID: 30, Capacity: 1}}

	// A flexible student is moved out of the way for one who can only take timeslot 10.
	m := newMatcher(timeslots, onlyIn(map[int64][]int64{2: {10}, 3: {10}}))
	if !m.place(1, -1) || m.placed[1] != 0 {
		t.Fatalf("flexible student placed in %d, want 0 (earliest)", m.placed[1])
	}
	if !m.place(2, -1) || m.placed[2] != 0 || m.placed[1] != 1 {
		t.Fatalf("after placing picky student: 1 in %d, 2 in %d; want 1, 0", m.placed[1], m.placed[2])
	}
	// Nobody in timeslot 10 can move, so a second student needing it doesn't fit.
	if m.place(3, -1) {
		t.Errorf("second picky student placed, want no room")
	}
	if !m.restricted(2) || m.restricted(1) {
		t.Errorf("restricted: 1 = %v, 2 = %v; want false, true", m.restricted(1), m.restricted(2))
	}

	// Near a timeslot: the closest free one.
	m = newMatcher(timeslots, anyTimeslot)
	m.place(1, 2)
	m.place(2, 2)
	if m.placed[1] != 2 || m.placed[2] != 1 {
		t.Errorf("near 2: placed in %d and %d, want 2 and 1", m.placed[1], m.placed[2])
	}
}
