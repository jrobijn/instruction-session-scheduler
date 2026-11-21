package scheduling

import (
	"slices"
	"testing"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// member is a queue member with just what scheduling looks at.
func member(id, groupID int64) queue.Member {
	return queue.Member{ID: id, GroupID: groupID}
}

// onlyIn returns an Allows func: students in only may take just the listed timeslot ids;
// everyone else any timeslot.
func onlyIn(only map[int64][]int64) func(studentID, timeslotID int64) bool {
	return func(studentID, timeslotID int64) bool {
		ts, restricted := only[studentID]
		return !restricted || slices.Contains(ts, timeslotID)
	}
}

func anyTimeslot(int64, int64) bool { return true }

func TestAllocateSlots(t *testing.T) {
	tests := []struct {
		name      string
		available int
		pcts      []float64
		want      []int
	}{
		{"remainder to the first groups", 10, []float64{33, 33, 34}, []int{4, 3, 3}},
		{"exact", 10, []float64{50, 50}, []int{5, 5}},
		{"zero percent still gets remainder", 3, []float64{0, 50}, []int{1, 2}},
		{"nothing available", 0, []float64{50, 50}, []int{0, 0}},
	}
	for _, tc := range tests {
		groups := make([]Group, len(tc.pcts))
		for i, p := range tc.pcts {
			groups[i] = Group{ID: int64(i + 1), Percentage: p}
		}
		got := AllocateSlots(tc.available, groups)
		slots := make([]int, len(got))
		for i, g := range got {
			slots[i] = g.Slots
		}
		if !slices.Equal(slots, tc.want) {
			t.Errorf("%s: slots %v, want %v", tc.name, slots, tc.want)
		}
		if groups[0].Slots != 0 {
			t.Errorf("%s: input modified", tc.name)
		}
	}
}

func TestGenerateReplacesUnplaceableStudent(t *testing.T) {
	// Two students only fit timeslot 10, which has one spot. The second is replaced by the
	// next in the group's queue, who takes the other timeslot.
	got := Generate(Input{
		Queue:     []queue.Member{member(1, 1), member(2, 1), member(3, 1)},
		Groups:    []Group{{ID: 1, Percentage: 100, Slots: 2}},
		Timeslots: []Timeslot{{ID: 10, Capacity: 1}, {ID: 20, Capacity: 1}},
		Allows:    onlyIn(map[int64][]int64{1: {10}, 2: {10}}),
	})
	if len(got) != 2 {
		t.Fatalf("got %d placements, want 2: %+v", len(got), got)
	}
	if p := got[0]; p.Member.ID != 1 || p.Timeslot != 0 || p.Rank != 1 || p.Considered != 3 {
		t.Errorf("first placement %+v, want student 1 in timeslot 0, rank 1 of 3", p)
	}
	if p := got[1]; p.Member.ID != 3 || p.Timeslot != 1 || p.Rank != 3 || p.Overflow {
		t.Errorf("second placement %+v, want replacement 3 in timeslot 1, rank 3, not overflow", p)
	}
}

func TestGenerateOverflow(t *testing.T) {
	// Group 2 has nobody left for its spare spot, so it goes to group 1's next student.
	got := Generate(Input{
		Queue:     []queue.Member{member(1, 1), member(2, 1), member(3, 2)},
		Groups:    []Group{{ID: 1, Percentage: 50, Slots: 1}, {ID: 2, Percentage: 50, Slots: 2}},
		Timeslots: []Timeslot{{ID: 10, Capacity: 3}},
		Allows:    anyTimeslot,
	})
	var ids []int64
	for _, p := range got {
		ids = append(ids, p.Member.ID)
	}
	if !slices.Equal(ids, []int64{1, 3, 2}) {
		t.Fatalf("placed %v, want [1 3 2]", ids)
	}
	if p := got[2]; !p.Overflow || p.GroupID != 1 || p.Rank != 1 || p.Considered != 1 {
		t.Errorf("overflow placement %+v, want group 1, rank 1 of 1", p)
	}
}

func TestGenerateBuddyPlacedNearBuddy(t *testing.T) {
	// 1 can only take the last timeslot; their buddy 2 is placed there too, not in the earliest.
	got := Generate(Input{
		Queue:     []queue.Member{member(1, 1), member(2, 1)},
		Groups:    []Group{{ID: 1, Percentage: 100, Slots: 2}},
		Timeslots: []Timeslot{{ID: 10, Capacity: 2}, {ID: 20, Capacity: 2}},
		Allows:    onlyIn(map[int64][]int64{1: {20}}),
		Buddies:   Buddies{1: {2}, 2: {1}},
	})
	for _, p := range got {
		if p.Timeslot != 1 {
			t.Errorf("student %d in timeslot %d, want 1 (with their buddy)", p.Member.ID, p.Timeslot)
		}
	}
}
