package scheduling

import (
	"slices"
	"testing"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// scripted returns a random source that yields the given values in order.
func scripted(values ...float64) func() float64 {
	return func() float64 {
		v := values[0]
		values = values[1:]
		return v
	}
}

func TestWeightedPickGroup(t *testing.T) {
	weights := map[int64]float64{1: 70, 2: 30, 3: 0, 5: -10}

	tests := []struct {
		name   string
		groups []int64
		draw   float64
		want   int64
	}{
		// Weighted: group 1 covers [0, 0.7), group 2 covers [0.7, 1); zero and negative weights are never picked.
		{"weighted start", []int64{1, 2, 3}, 0, 1},
		{"weighted just below boundary", []int64{1, 2, 3}, 0.6999, 1},
		{"weighted at boundary", []int64{1, 2, 3}, 0.7, 2},
		{"weighted end", []int64{1, 2, 3}, 0.9999, 2},
		{"zero weight first", []int64{3, 1}, 0, 1},
		{"negative weight first", []int64{5, 2}, 0, 2},
		// Uniform: all weights zero or missing, so each group gets an equal share.
		{"uniform first", []int64{3, 4}, 0.4999, 3},
		{"uniform second", []int64{3, 4}, 0.5, 4},
		{"uniform last", []int64{3, 4, 6}, 0.9999, 6},
	}
	for _, tc := range tests {
		if got := weightedPickGroup(tc.groups, weights, scripted(tc.draw)); got != tc.want {
			t.Errorf("%s: draw %v picked %d, want %d", tc.name, tc.draw, got, tc.want)
		}
	}
}

func TestPools(t *testing.T) {
	ids := func(ms []queue.Member) []int64 {
		out := []int64{}
		for _, m := range ms {
			out = append(out, m.ID)
		}
		return out
	}
	p := newPools([]queue.Member{{ID: 1, GroupID: 20}, {ID: 2, GroupID: 10}, {ID: 3, GroupID: 20}})

	if got := ids(p.group(20)); !slices.Equal(got, []int64{1, 3}) {
		t.Errorf("Group(20) = %v, want queue order [1 3]", got)
	}
	if got := p.group(99); got != nil {
		t.Errorf("group(99) = %v, want nil", got)
	}
	// Uniform pick (no weights) over the groups in order of first appearance: 20, then 10.
	if got := p.pickWeighted(nil, scripted(0.5)); got != 10 {
		t.Errorf("pickWeighted = %d, want 10 (second group by first appearance)", got)
	}

	if m := p.pop(20); m.ID != 1 {
		t.Errorf("pop(20) = %d, want 1", m.ID)
	}
	if m := p.pop(10); m.ID != 2 {
		t.Errorf("pop(10) = %d, want 2", m.ID)
	}
	// Group 10 is empty now, so only group 20 can be picked.
	if got := p.pickWeighted(map[int64]float64{10: 100}, scripted(0.9)); got != 20 {
		t.Errorf("pickWeighted after emptying 10 = %d, want 20", got)
	}
	if m := p.pop(20); m.ID != 3 || !p.empty() {
		t.Errorf("last Pop = %d, empty = %v; want 3, true", m.ID, p.empty())
	}
}
