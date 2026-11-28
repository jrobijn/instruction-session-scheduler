package scheduling

import (
	"slices"
	"sort"
)

// matcher matches students to timeslots within each timeslot's capacity. Placing a student
// may move students placed earlier to another timeslot they allow (an augmenting path), but
// never unplaces anyone.
type matcher struct {
	timeslots []Timeslot
	allows    func(studentID, timeslotID int64) bool
	buddies   Buddies
	occupants [][]int64       // per timeslot index, its students in the order they came in
	placed    map[int64]int   // student -> timeslot index
	allowed   map[int64][]int // cache for allowedTimeslots
}

func newMatcher(timeslots []Timeslot, allows func(studentID, timeslotID int64) bool, buddies Buddies) *matcher {
	return &matcher{
		timeslots: timeslots,
		allows:    allows,
		buddies:   buddies,
		occupants: make([][]int64, len(timeslots)),
		placed:    map[int64]int{},
		allowed:   map[int64][]int{},
	}
}

func (m *matcher) totalCapacity() int {
	total := 0
	for _, ts := range m.timeslots {
		total += ts.Capacity
	}

	return total
}

// allowedTimeslots lists the indexes of the timeslots the student may take, earliest first.
func (m *matcher) allowedTimeslots(sid int64) []int {
	if a, ok := m.allowed[sid]; ok {
		return a
	}

	a := []int{}
	for i, ts := range m.timeslots {
		if m.allows(sid, ts.ID) {
			a = append(a, i)
		}
	}

	m.allowed[sid] = a
	return a
}

// restricted reports whether the student may not take every timeslot. (Preferring all of
// them is no restriction.)
func (m *matcher) restricted(sid int64) bool {
	return len(m.allowedTimeslots(sid)) < len(m.timeslots)
}

// place puts the student in the earliest allowed timeslot with room. It reports false if
// there is no room for them, even after moving others.
func (m *matcher) place(sid int64) bool {
	return m.tryPlace(sid, m.allowedTimeslots(sid), map[int]bool{}, false)
}

// placeNearBuddy puts the student in an allowed timeslot as close to timeslot ti (a placed
// buddy's) as possible. It reports false if there is no room for them, even after moving
// others.
//
// The closest timeslot wins even when it is full, if students without buddies can move to make
// room: that keeps buddies together, where taking free room further away would split them.
// Students with buddies are only moved when the student fits nowhere otherwise.
func (m *matcher) placeNearBuddy(sid int64, ti int) bool {
	order := m.orderedTimeslots(sid, ti)
	for _, near := range order {
		if m.tryPlace(sid, []int{near}, map[int]bool{}, true) {
			return true
		}
	}

	return m.tryPlace(sid, order, map[int]bool{}, false)
}

// orderedTimeslots lists the student's allowed timeslots closest to timeslot near first,
// earliest first among equally close ones.
func (m *matcher) orderedTimeslots(sid int64, near int) []int {
	out := slices.Clone(m.allowedTimeslots(sid))
	abs := func(x int) int { return max(x, -x) }

	// allowed is ascending, so the stable sort keeps the earlier timeslot first on ties.
	sort.SliceStable(out, func(i, j int) bool {
		return abs(out[i]-near) < abs(out[j]-near)
	})

	return out
}

// tryPlace puts the student in the first timeslot of order with room. Failing that, it tries
// each timeslot not visited yet on this path, moving one of its occupants elsewhere to make
// room. With keepBuddies, no student with buddies is moved anywhere along the path.
func (m *matcher) tryPlace(sid int64, order []int, visited map[int]bool, keepBuddies bool) bool {
	for _, ti := range order {
		if !visited[ti] && len(m.occupants[ti]) < m.timeslots[ti].Capacity {
			m.put(sid, ti)
			return true
		}
	}

	for _, ti := range order {
		if visited[ti] {
			continue
		}

		visited[ti] = true
		for _, other := range m.movable(sid, ti) {
			if other == sid || keepBuddies && len(m.buddies[other]) > 0 {
				continue
			}

			if m.tryPlace(other, m.orderedTimeslots(other, ti), visited, keepBuddies) {
				m.put(sid, ti)
				return true
			}
		}
	}

	return false
}

// movable lists the occupants of timeslot ti to try moving out for the student, in the order
// they came in but with the student's buddies last, so making room doesn't split them up
// when moving someone else would do.
func (m *matcher) movable(sid int64, ti int) []int64 {
	out := slices.Clone(m.occupants[ti])
	isBuddy := func(x int64) bool { return slices.Contains(m.buddies[sid], x) }
	sort.SliceStable(out, func(i, j int) bool { return !isBuddy(out[i]) && isBuddy(out[j]) })
	return out
}

func (m *matcher) put(sid int64, ti int) {
	if prev, ok := m.placed[sid]; ok {
		m.occupants[prev] = slices.DeleteFunc(m.occupants[prev], func(x int64) bool { return x == sid })
	}

	m.occupants[ti] = append(m.occupants[ti], sid)
	m.placed[sid] = ti
}
