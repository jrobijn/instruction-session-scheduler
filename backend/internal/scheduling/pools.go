package scheduling

import (
	"math"
	"slices"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// pools is a queue split into one queue per group. Each group's queue keeps the order of the
// members it was made from; groups are ordered by where their first member appeared.
type pools struct {
	order   []int64
	byGroup map[int64][]queue.Member
}

// newPools splits members, in queue order, by group.
func newPools(members []queue.Member) *pools {
	p := &pools{byGroup: map[int64][]queue.Member{}}
	for _, m := range members {
		if _, seen := p.byGroup[m.GroupID]; !seen {
			p.order = append(p.order, m.GroupID)
		}
		p.byGroup[m.GroupID] = append(p.byGroup[m.GroupID], m)
	}
	return p
}

// group returns the queue of a group; empty (nil) if it has no members left. Callers must
// not modify it.
func (p *pools) group(groupID int64) []queue.Member { return p.byGroup[groupID] }

// empty reports whether no group has members left.
func (p *pools) empty() bool { return len(p.order) == 0 }

// pickWeighted picks one of the groups with members left, weighted by weightByGroup (see
// weightedPickGroup). Call only when !empty().
func (p *pools) pickWeighted(weightByGroup map[int64]float64, random func() float64) int64 {
	return weightedPickGroup(p.order, weightByGroup, random)
}

// pop removes and returns the first member of a group's queue. A group whose queue becomes
// empty is dropped, so it can't be picked any more. Call only for a group with members left.
func (p *pools) pop(groupID int64) queue.Member {
	q := p.byGroup[groupID]
	if len(q) == 1 {
		delete(p.byGroup, groupID)
		p.order = slices.DeleteFunc(p.order, func(g int64) bool { return g == groupID })
	} else {
		p.byGroup[groupID] = q[1:]
	}
	return q[0]
}

// weightedPickGroup picks a group id weighted by weightByGroup. When all weights are
// zero or missing, the pick is uniform.
func weightedPickGroup(groupIDs []int64, weightByGroup map[int64]float64, random func() float64) int64 {
	weights := make([]float64, len(groupIDs))
	total := 0.0
	for i, g := range groupIDs {
		weights[i] = math.Max(0, weightByGroup[g])
		total += weights[i]
	}
	if total <= 0 {
		return groupIDs[int(math.Floor(random()*float64(len(groupIDs))))]
	}
	r := random() * total
	for i, g := range groupIDs {
		r -= weights[i]
		if r < 0 {
			return g
		}
	}
	return groupIDs[len(groupIDs)-1]
}
