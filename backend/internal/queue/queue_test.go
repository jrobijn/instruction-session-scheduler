package queue

import (
	"reflect"
	"testing"
)

type row struct {
	id         int64
	inviteNext *string
	queueAt    string
}

func (r row) QueueID() int64      { return r.id }
func (r row) QueueTieKey() string { return TieKey(r.inviteNext, r.queueAt) }

// The expected orders pin the hash-based shuffle: a change to it reorders existing queues.
func TestBreakTies(t *testing.T) {
	feb := "2026-02-02"
	rows := []row{
		{1, nil, ""}, {2, nil, ""}, {3, nil, ""},
		{4, nil, "2026-01-01"}, {5, &feb, ""}, {6, &feb, ""},
		{7, nil, "2026-01-01"}, {8, nil, "2026-01-01"},
	}
	want := map[int64][]int64{
		1:  {2, 3, 1, 4, 6, 5, 7, 8},
		7:  {3, 2, 1, 4, 5, 6, 7, 8},
		99: {3, 1, 2, 4, 6, 5, 7, 8},
	}
	for seed, expected := range want {
		var got []int64
		for _, r := range BreakTies(rows, seed) {
			got = append(got, r.id)
		}
		if !reflect.DeepEqual(got, expected) {
			t.Errorf("seed %d: got %v, want %v", seed, got, expected)
		}
	}
}

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
		if got := WeightedPickGroup(tc.groups, weights, scripted(tc.draw)); got != tc.want {
			t.Errorf("%s: draw %v picked %d, want %d", tc.name, tc.draw, got, tc.want)
		}
	}
}
