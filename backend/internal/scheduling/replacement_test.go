package scheduling

import (
	"testing"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

func TestPickReplacement(t *testing.T) {
	// Queue order: 1 (group 1, only timeslot 10), 2 (group 2), 3 (group 1), 4 (group 3),
	// 5 (group 1), 6 (group 2).
	q := []queue.Member{member(1, 1), member(2, 2), member(3, 1), member(4, 3), member(5, 1), member(6, 2)}
	allows := onlyIn(map[int64][]int64{1: {10}})
	groups := []Group{{ID: 1, Percentage: 50}, {ID: 2, Percentage: 0}, {ID: 3, Percentage: 50}}
	// 5 is buddies with 100, 6 with 101 (neither in the queue: they are invited already or not
	// eligible). 2 is buddies with 102, who declined (not invited).
	buddies := Buddies{5: {100}, 100: {5}, 6: {101}, 101: {6}, 2: {102}, 102: {2}}

	tests := []struct {
		name    string
		queue   []queue.Member
		vacancy Vacancy
		invited []int64
		want    ReplacementPick
	}{
		{"first of the vacancy's group", q, Vacancy{TimeslotID: 10, GroupID: 1}, nil,
			ReplacementPick{Member: q[0], GroupID: 1, Rank: 1, Considered: 3, SameGroup: true}},
		{"skips students preferring another timeslot", q, Vacancy{TimeslotID: 20, GroupID: 1}, nil,
			ReplacementPick{Member: q[2], GroupID: 1, Rank: 1, Considered: 2, SameGroup: true}},
		{"no group: first of the whole queue", q, Vacancy{TimeslotID: 20}, nil,
			ReplacementPick{Member: q[1], GroupID: 2, Rank: 1, Considered: 5, SameGroup: true}},

		{"buddy of an invited student pulled up", q, Vacancy{TimeslotID: 10, GroupID: 1}, []int64{100},
			ReplacementPick{Member: q[4], GroupID: 1, Rank: 3, Considered: 3, SameGroup: true, PulledUpBy: 100}},
		{"buddy in another group not pulled up", q, Vacancy{TimeslotID: 10, GroupID: 1}, []int64{101},
			ReplacementPick{Member: q[0], GroupID: 1, Rank: 1, Considered: 3, SameGroup: true}},
		{"no group: buddy pulled up across groups", q, Vacancy{TimeslotID: 20}, []int64{101},
			ReplacementPick{Member: q[5], GroupID: 2, Rank: 5, Considered: 5, SameGroup: true, PulledUpBy: 101}},
		{"first pulled-up buddy in line wins", q, Vacancy{TimeslotID: 20}, []int64{100, 101},
			ReplacementPick{Member: q[4], GroupID: 1, Rank: 4, Considered: 5, SameGroup: true, PulledUpBy: 100}},

		// Group 1 is empty: groups 2 (weight 0) and 3 (weight 50) are left, so 3 is picked.
		// 6's buddy is invited, but buddies play no part when picking from another group.
		{"another group, weighted, without buddies", []queue.Member{q[3], q[5]}, Vacancy{TimeslotID: 10, GroupID: 1}, []int64{101},
			ReplacementPick{Member: q[3], GroupID: 3, Rank: 1, Considered: 1}},
	}
	for _, tc := range tests {
		invited := map[int64]bool{}
		for _, id := range tc.invited {
			invited[id] = true
		}
		got, ok := PickReplacement(ReplacementInput{
			Queue: tc.queue, Groups: groups, Allows: allows, Vacancy: tc.vacancy,
			Buddies: buddies, Invited: invited, Random: scripted(0),
		})
		if !ok || got.Member.ID != tc.want.Member.ID || got.GroupID != tc.want.GroupID || got.Rank != tc.want.Rank ||
			got.Considered != tc.want.Considered || got.SameGroup != tc.want.SameGroup || got.PulledUpBy != tc.want.PulledUpBy {
			t.Errorf("%s: got %+v (ok %v), want %+v", tc.name, got, ok, tc.want)
		}
	}

	// Nobody can take the spot: only student 1 is left and they only take timeslot 10.
	for _, v := range []Vacancy{{TimeslotID: 20, GroupID: 1}, {TimeslotID: 20}} {
		if got, ok := PickReplacement(ReplacementInput{Queue: q[:1], Groups: groups, Allows: allows, Vacancy: v}); ok {
			t.Errorf("vacancy %+v: picked %+v, want nobody", v, got)
		}
	}
}
