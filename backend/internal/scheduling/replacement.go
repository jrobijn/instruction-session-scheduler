package scheduling

import "github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"

// ReplacementInput is everything PickReplacement needs.
type ReplacementInput struct {
	// Queue is everyone who can be invited, in queue order.
	Queue []queue.Member
	// Groups are the timetable's groups; only their percentages are used.
	Groups []Group
	// Allows reports whether a student may take a timeslot (by id).
	Allows func(studentID, timeslotID int64) bool
	// Vacancy is the spot to fill.
	Vacancy Vacancy
	// Buddies lists each student's buddies.
	Buddies Buddies
	// Invited holds the students with an active (scheduled, invited or confirmed) invitation
	// to the session: their buddies are pulled up.
	Invited map[int64]bool
	// Random is the random source for picking another group (see PickReplacement).
	Random func() float64
}

// Vacancy is a spot that was given up and needs a new student.
type Vacancy struct {
	TimeslotID int64
	// GroupID is the group of the invitation that held the spot; 0 if it had none (it was
	// added manually).
	GroupID int64
}

// ReplacementPick is the student chosen for a vacancy.
type ReplacementPick struct {
	Member queue.Member
	// GroupID is the group the new invitation counts for.
	GroupID int64
	// Rank is the student's position in the queue they were picked from, 1 first, out of
	// Considered students. It is 1 unless they were pulled up.
	Rank, Considered int
	// SameGroup is set when the student comes from the vacancy's group (or, for a vacancy
	// without a group, from the whole queue).
	SameGroup bool
	// PulledUpBy is the invited buddy who pulled the student up; 0 if none.
	PulledUpBy int64
}

// PickReplacement chooses who gets a vacancy, among the students who may take its timeslot:
//
//  1. from the vacancy's group (for a vacancy without a group: the whole queue), the first in
//     line whose buddy is invited to the session; failing that, the first in line;
//  2. otherwise the first in line of another group, picked at random weighted by percentage.
//     Buddies play no part here, as in Generate's overflow.
//
// Rule 1 is Generate's buddy pull-up for a single spot: a buddy of a student who got a turn
// is next in line after them. The buddy's timeslot doesn't matter: the vacancy's is fixed.
//
// It reports false when nobody can take the spot.
func PickReplacement(in ReplacementInput) (ReplacementPick, bool) {
	var candidates []queue.Member
	for _, m := range in.Queue {
		if in.Allows(m.ID, in.Vacancy.TimeslotID) {
			candidates = append(candidates, m)
		}
	}

	if in.Vacancy.GroupID == 0 {
		if len(candidates) == 0 {
			return ReplacementPick{}, false
		}
		return in.pickWithBuddies(candidates), true
	}

	byGroup := newPools(candidates)
	if q := byGroup.group(in.Vacancy.GroupID); len(q) > 0 {
		return in.pickWithBuddies(q), true
	}
	if byGroup.empty() {
		return ReplacementPick{}, false
	}
	percentage := map[int64]float64{}
	for _, g := range in.Groups {
		percentage[g.ID] = g.Percentage
	}
	picked := byGroup.pickWeighted(percentage, in.Random)
	q := byGroup.group(picked)
	return ReplacementPick{Member: q[0], GroupID: picked, Rank: 1, Considered: len(q)}, true
}

// pickWithBuddies applies rule 1 of PickReplacement to a non-empty queue.
func (in ReplacementInput) pickWithBuddies(q []queue.Member) ReplacementPick {
	pick := func(i int, pulledUpBy int64) ReplacementPick {
		m := q[i]
		return ReplacementPick{Member: m, GroupID: m.GroupID, Rank: i + 1, Considered: len(q), SameGroup: true, PulledUpBy: pulledUpBy}
	}
	for i, m := range q {
		for _, buddy := range in.Buddies[m.ID] {
			if in.Invited[buddy] {
				return pick(i, buddy)
			}
		}
	}
	return pick(0, 0)
}
