package scheduling

import (
	"slices"
	"testing"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

func TestSelectWithBuddies(t *testing.T) {
	list := []queue.Member{member(1, 1), member(2, 1), member(3, 1), member(4, 1), member(5, 1)}
	buddies := Buddies{1: {4}, 4: {1}}
	ids := func(ms []queue.Member) []int64 {
		out := []int64{}
		for _, m := range ms {
			out = append(out, m.ID)
		}
		return out
	}

	// 4 is pulled up right after their buddy 1, ahead of 2 and 3.
	sel, rest := selectWithBuddies(list, 3, buddies)
	var got []int64
	for _, s := range sel {
		got = append(got, s.member.ID)
	}
	if !slices.Equal(got, []int64{1, 4, 2}) || !slices.Equal(ids(rest), []int64{3, 5}) {
		t.Fatalf("selected %v, rest %v; want [1 4 2], [3 5]", got, ids(rest))
	}
	if sel[0].pulledUpBy != nil || sel[1].pulledUpBy == nil || sel[1].pulledUpBy.ID != 1 || sel[2].pulledUpBy != nil {
		t.Errorf("pulledUpBy wrong: %+v", sel)
	}

	// A buddy is not pulled up past the quota.
	sel, rest = selectWithBuddies(list, 1, buddies)
	if len(sel) != 1 || sel[0].member.ID != 1 || !slices.Equal(ids(rest), []int64{2, 3, 4, 5}) {
		t.Errorf("quota 1: selected %+v, rest %v; want only 1", sel, ids(rest))
	}
}
