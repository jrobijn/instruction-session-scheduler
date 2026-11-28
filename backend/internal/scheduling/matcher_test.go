package scheduling

import "testing"

func TestMatcher(t *testing.T) {
	timeslots := []Timeslot{{ID: 10, Capacity: 1}, {ID: 20, Capacity: 1}, {ID: 30, Capacity: 1}}

	// A flexible student is moved out of the way for one who can only take timeslot 10.
	m := newMatcher(timeslots, onlyIn(map[int64][]int64{2: {10}, 3: {10}}), nil)
	if !m.place(1) || m.placed[1] != 0 {
		t.Fatalf("flexible student placed in %d, want 0 (earliest)", m.placed[1])
	}
	if !m.place(2) || m.placed[2] != 0 || m.placed[1] != 1 {
		t.Fatalf("after placing picky student: 1 in %d, 2 in %d; want 1, 0", m.placed[1], m.placed[2])
	}

	// Nobody in timeslot 10 can move, so a second student needing it doesn't fit.
	if m.place(3) {
		t.Errorf("second picky student placed, want no room")
	}
	if !m.restricted(2) || m.restricted(1) {
		t.Errorf("restricted: 1 = %v, 2 = %v; want false, true", m.restricted(1), m.restricted(2))
	}

	// Near a buddy who can't move: the closest free timeslot, not the earliest.
	m = newMatcher(timeslots, onlyIn(map[int64][]int64{1: {30}}), Buddies{1: {2}, 2: {1}})
	m.place(1)
	if !m.placeNearBuddy(2, m.placed[1]) || m.placed[1] != 2 || m.placed[2] != 1 {
		t.Errorf("near buddy: placed 1, 2 in %d, %d; want 2, 1", m.placed[1], m.placed[2])
	}
}

func TestMatcherMovesBuddyLast(t *testing.T) {
	timeslots := []Timeslot{{ID: 10, Capacity: 2}, {ID: 20, Capacity: 1}}

	// 3 can only take timeslot 10, which 1 (3's buddy) and 2 fill. Either could move to 20;
	// moving 2 keeps the buddies together, though 1 came in first.
	m := newMatcher(timeslots, onlyIn(map[int64][]int64{1: {10, 20}, 2: {10, 20}, 3: {10}}), Buddies{1: {3}, 3: {1}})
	m.place(1)
	m.place(2)
	if !m.placeNearBuddy(3, m.placed[1]) {
		t.Fatalf("3 not placed")
	}
	if m.placed[1] != 0 || m.placed[2] != 1 || m.placed[3] != 0 {
		t.Errorf("placed 1, 2, 3 in %d, %d, %d; want 0, 1, 0", m.placed[1], m.placed[2], m.placed[3])
	}

	// When only the buddy can move, they still make room.
	m = newMatcher(timeslots, onlyIn(map[int64][]int64{2: {10}, 3: {10}}), Buddies{1: {3}, 3: {1}})
	m.place(1)
	m.place(2)
	if !m.placeNearBuddy(3, m.placed[1]) || m.placed[1] != 1 || m.placed[3] != 0 {
		t.Errorf("placed 1, 3 in %d, %d; want 1, 0", m.placed[1], m.placed[3])
	}
}

func TestMatcherMakesRoomNearBuddy(t *testing.T) {
	timeslots := []Timeslot{{ID: 10, Capacity: 2}, {ID: 20, Capacity: 1}, {ID: 30, Capacity: 1}}

	// 1 (3's buddy) and 2 fill timeslot 10 while 20 has room: 2 moves to 20 so 3 joins 1.
	m := newMatcher(timeslots, anyTimeslot, Buddies{1: {3}, 3: {1}})
	m.place(1)
	m.place(2)
	if !m.placeNearBuddy(3, m.placed[1]) || m.placed[2] != 1 || m.placed[3] != 0 {
		t.Errorf("placed 2, 3 in %d, %d; want 1, 0", m.placed[2], m.placed[3])
	}

	// 2 may only take timeslot 10, so 3 takes the free room closest to 1.
	m = newMatcher(timeslots, onlyIn(map[int64][]int64{2: {10}}), Buddies{1: {3}, 3: {1}})
	m.place(1)
	m.place(2)
	if !m.placeNearBuddy(3, m.placed[1]) || m.placed[2] != 0 || m.placed[3] != 1 {
		t.Errorf("2 can't move: placed 2, 3 in %d, %d; want 0, 1", m.placed[2], m.placed[3])
	}

	// 2 has buddies of their own, so 2 isn't moved away from them either.
	m = newMatcher(timeslots, anyTimeslot, Buddies{1: {3}, 3: {1}, 2: {4}, 4: {2}})
	m.place(1)
	m.place(2)
	if !m.placeNearBuddy(3, m.placed[1]) || m.placed[2] != 0 || m.placed[3] != 1 {
		t.Errorf("2 has buddies: placed 2, 3 in %d, %d; want 0, 1", m.placed[2], m.placed[3])
	}
}

func TestMatcherDoesNotSplitBuddiesForCloseness(t *testing.T) {
	timeslots := []Timeslot{{ID: 10, Capacity: 2}, {ID: 20, Capacity: 2}, {ID: 30, Capacity: 1}}

	// 3 wants to join buddy 1 in timeslot 10. Making room there would take 2 to 20 and push
	// one of the buddies 4 and 5 from 20 into 30, so 3 takes the free spot in 30 instead.
	m := newMatcher(timeslots, onlyIn(map[int64][]int64{2: {10, 20}}), Buddies{1: {3}, 3: {1}, 4: {5}, 5: {4}})
	m.place(1)
	m.place(2)
	m.place(4)
	m.placeNearBuddy(5, m.placed[4])
	if !m.placeNearBuddy(3, m.placed[1]) {
		t.Fatalf("3 not placed")
	}
	if m.placed[2] != 0 || m.placed[3] != 2 || m.placed[4] != 1 || m.placed[5] != 1 {
		t.Errorf("placed 2, 3, 4, 5 in %d, %d, %d, %d; want 0, 2, 1, 1", m.placed[2], m.placed[3], m.placed[4], m.placed[5])
	}
}
