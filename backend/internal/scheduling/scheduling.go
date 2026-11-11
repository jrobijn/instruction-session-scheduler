// Package scheduling decides who is invited to a session and in which timeslot. It does no I/O:
// the caller loads the queue and timetable and writes the invitations (see
// server.handleGenerateSchedule and server.findAndInviteReplacement).
//
// Generate fills a whole session; PickReplacement fills one spot that was given up.
//
// Generate works in two stages:
//
//  1. Selection: each group gets its quota of slots (AllocateSlots) and takes that many
//     students from the front of its queue, pulling buddies up along the way
//     (selectWithBuddies).
//  2. Placement: the selected students are matched to timeslots (matcher), those with
//     timeslot preferences first. A student who can't be placed is replaced by the next in
//     their group's queue. Spots still free after that go to the remaining students of any
//     group (overflow).
//
// Iteration orders are deterministic on purpose: they decide who gets moved or placed.
package scheduling

import (
	"math"
	mrand "math/rand/v2"
	"slices"
	"sort"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// Input is everything Generate needs.
type Input struct {
	// Queue is everyone who can be invited, in queue order.
	Queue []queue.Member
	// Groups are the timetable's groups in their configured order, with their quotas (see
	// AllocateSlots).
	Groups []Group
	// Timeslots are the timetable's timeslots, earliest first, with the number of free spots
	// in each.
	Timeslots []Timeslot
	// Allows reports whether a student may take a timeslot (by id).
	Allows func(studentID, timeslotID int64) bool
	// Buddies lists each student's buddies.
	Buddies Buddies
	// Seed makes the overflow picks reproducible: the same seed gives the same picks.
	Seed int64
}

// Buddies lists, per student, the other members of their buddy group (a student is in at
// most one), in the order they were added. A student is placed near their first buddy who
// is placed already, so the order matters.
type Buddies map[int64][]int64

// Group is a timetable group: its share of the spots and the number of slots that gives it.
type Group struct {
	ID         int64
	Percentage float64
	Slots      int
}

// Timeslot is a timeslot with the number of spots still free in it.
type Timeslot struct {
	ID       int64
	Capacity int
}

// Placement is a student matched to a timeslot, with how they were chosen.
type Placement struct {
	Member   queue.Member
	Timeslot int   // index into Input.Timeslots
	GroupID  int64 // the group whose quota (or overflow pick) the student was placed in
	// Rank is the student's position among the Considered candidates, 1 first: in their
	// group's queue, or in overflow among all overflow candidates.
	Rank, Considered int
	// PulledUpBy is the buddy who pulled the student up within their group's quota, if any.
	PulledUpBy *queue.Member
	// Overflow is set when the student was placed beyond the group quotas.
	Overflow bool
}

// AllocateSlots returns groups with Slots set: each group's percentage of available,
// rounded down, plus one extra each for the first groups until all are allocated.
func AllocateSlots(available int, groups []Group) []Group {
	out := slices.Clone(groups)
	allocated := 0
	for i := range out {
		out[i].Slots = int(math.Floor(float64(available) * out[i].Percentage / 100))
		allocated += out[i].Slots
	}
	for i := 0; i < len(out) && allocated < available; i++ {
		out[i].Slots++
		allocated++
	}
	return out
}

// Generate places students in timeslots; see the package documentation. The placements are
// in the order they were made.
func Generate(in Input) []Placement {
	m := newMatcher(in.Timeslots, in.Allows)
	// A student goes in or near the timeslot of their first buddy who is placed already.
	place := func(sid int64) bool {
		for _, buddy := range in.Buddies[sid] {
			if ti, ok := m.placed[buddy]; ok {
				return m.place(sid, ti)
			}
		}
		return m.place(sid, -1)
	}

	// ----- Selection: per group, the first Slots students, with buddies pulled up -----
	byGroup := newPools(in.Queue)
	chosen := map[int64]*Placement{} // how each student up for placement was chosen
	choose := func(st queue.Member, groupID int64, pulledUpBy *queue.Member) {
		list := byGroup.group(groupID)
		rank := slices.IndexFunc(list, func(x queue.Member) bool { return x.ID == st.ID }) + 1
		chosen[st.ID] = &Placement{Member: st, GroupID: groupID, Rank: rank, Considered: len(list), PulledUpBy: pulledUpBy}
	}
	var selected []queue.Member
	remaining := map[int64][]queue.Member{} // per group, the students not selected, in queue order
	for _, g := range in.Groups {
		sel, rest := selectWithBuddies(byGroup.group(g.ID), g.Slots, in.Buddies)
		for _, s := range sel {
			selected = append(selected, s.member)
			choose(s.member, g.ID, s.pulledUpBy)
		}
		remaining[g.ID] = rest
	}

	// ----- Placement -----
	queueIndex := map[int64]int{}
	for i, st := range in.Queue {
		queueIndex[st.ID] = i
	}
	byQueue := func(list []queue.Member) {
		sort.SliceStable(list, func(i, j int) bool { return queueIndex[list[i].ID] < queueIndex[list[j].ID] })
	}
	var withPreference, withoutPreference []queue.Member
	for _, st := range selected {
		if m.restricted(st.ID) {
			withPreference = append(withPreference, st)
		} else {
			withoutPreference = append(withoutPreference, st)
		}
	}
	byQueue(withPreference)
	byQueue(withoutPreference)
	var placed []queue.Member
	// Placing more students never frees room, so a student who failed once can't be placed later.
	unplaceable := map[int64]bool{}

	// Phase 1: students with timeslot preferences; an unplaceable one is replaced by the next
	// candidate of their group.
	for len(withPreference) > 0 {
		st := withPreference[0]
		withPreference = withPreference[1:]
		if place(st.ID) {
			placed = append(placed, st)
			continue
		}
		unplaceable[st.ID] = true
		gid := chosen[st.ID].GroupID
		delete(chosen, st.ID)
		rest := remaining[gid]
		if len(rest) == 0 {
			continue
		}
		repl := rest[0]
		remaining[gid] = rest[1:]
		choose(repl, gid, nil)
		if m.restricted(repl.ID) {
			withPreference = append(withPreference, repl)
		} else {
			withoutPreference = append(withoutPreference, repl)
		}
	}

	// Phase 2: students without preferences fill the remaining spots.
	for _, st := range withoutPreference {
		if place(st.ID) {
			placed = append(placed, st)
		} else {
			delete(chosen, st.ID)
			unplaceable[st.ID] = true
		}
	}

	// Phase 3 (overflow): remaining spots go to students of any group not tried yet. Each pick
	// chooses a group at random (weighted by percentage) and tries its first candidate.
	var overflowCandidates []queue.Member
	for _, st := range in.Queue {
		if _, isPlaced := m.placed[st.ID]; !isPlaced && !unplaceable[st.ID] {
			overflowCandidates = append(overflowCandidates, st)
		}
	}
	percentage := map[int64]float64{}
	for _, g := range in.Groups {
		percentage[g.ID] = g.Percentage
	}
	overflow := newPools(overflowCandidates)
	random := mrand.New(mrand.NewPCG(uint64(in.Seed), 0)).Float64
	overflowRank := 0
	for !overflow.empty() && len(m.placed) < m.totalCapacity() {
		picked := overflow.pickWeighted(percentage, random)
		st := overflow.pop(picked)
		overflowRank++
		if !place(st.ID) {
			continue
		}
		placed = append(placed, st)
		chosen[st.ID] = &Placement{Member: st, GroupID: picked, Rank: overflowRank, Considered: len(overflowCandidates), Overflow: true}
	}

	// Students may have moved timeslots after being placed, so the final ones are read last.
	out := make([]Placement, len(placed))
	for i, st := range placed {
		out[i] = *chosen[st.ID]
		out[i].Timeslot = m.placed[st.ID]
	}
	return out
}
