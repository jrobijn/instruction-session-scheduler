package queue

import (
	"reflect"
	"testing"
)

// Expected values were produced by running backend/src/priority.ts under Node.

func TestSeededRandomMatchesTS(t *testing.T) {
	want := map[int64][]float64{
		0:          {0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086},
		1:          {0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849},
		42:         {0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423},
		123456789:  {0.2577907438389957, 0.9707721115555614, 0.7853280142880976, 0.20616457983851433, 0.30307188746519387},
		4294967295: {0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489},
	}
	for seed, expected := range want {
		r := SeededRandom(seed)
		for i, w := range expected {
			if got := r(); got != w {
				t.Errorf("seed %d draw %d = %v, want %v", seed, i, got, w)
			}
		}
	}
}

type row struct {
	id         int64
	inviteNext *string
	queueAt    string
}

func (r row) QueueID() int64      { return r.id }
func (r row) QueueTieKey() string { return TieKey(r.inviteNext, r.queueAt) }

func TestBreakTiesMatchesTS(t *testing.T) {
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

func TestWeightedPickGroupMatchesTS(t *testing.T) {
	weights := map[int64]float64{1: 70, 2: 30, 3: 0}

	r := SeededRandom(5)
	var got []int64
	for range 12 {
		got = append(got, WeightedPickGroup([]int64{1, 2, 3}, weights, r))
	}
	if want := []int64{1, 2, 1, 1, 1, 1, 2, 1, 2, 1, 2, 2}; !reflect.DeepEqual(got, want) {
		t.Errorf("weighted: got %v, want %v", got, want)
	}

	r = SeededRandom(9)
	got = nil
	for range 8 {
		got = append(got, WeightedPickGroup([]int64{3, 4}, weights, r))
	}
	if want := []int64{3, 4, 3, 4, 4, 4, 3, 4}; !reflect.DeepEqual(got, want) {
		t.Errorf("uniform: got %v, want %v", got, want)
	}
}
