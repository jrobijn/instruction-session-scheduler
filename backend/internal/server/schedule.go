package server

import (
	"fmt"
	"math"
	mrand "math/rand/v2"
	"net/http"
	"slices"
	"sort"
	"strconv"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// POST /api/sessions/:id/generate-schedule. Iteration orders (insertion order, stable sorts)
// are kept deterministic on purpose: they decide who gets moved or placed.

// candidate is a student in a group's invitation queue. Load it with queueCandidates.
type candidate struct {
	ID            int64  `db:"id"`
	FirstName     string `db:"first_name"`
	LastName      string `db:"last_name"`
	Email         string `db:"email"`
	PreferredDays string `db:"preferred_days"`
	GroupID       int64  `db:"group_id"`
	queue.Columns
}

func (c candidate) QueueID() int64 { return c.ID }

// queueCandidates loads the students matching where, a WHERE clause (usually followed by
// ORDER BY queue.OrderSQL) over s (students), sg (their student_groups row) and the queue joins.
func (s *Server) queueCandidates(where string, args ...any) ([]candidate, error) {
	return db.Many[candidate](s.db, `
		SELECT s.id, s.first_name, s.last_name, s.email, s.preferred_days, sg.group_id, `+queue.ColumnsSQL+`
		FROM students s
		JOIN student_groups sg ON sg.student_id = s.id
		`+queue.JoinSQL+`
		`+where, args...)
}

// ScheduledInvitation is an invitation created by generating a schedule.
type ScheduledInvitation struct {
	StudentID  int64  `json:"student_id"`
	FirstName  string `json:"first_name"`
	LastName   string `json:"last_name"`
	Token      string `json:"token"`
	TimeslotID int64  `json:"timeslot_id"`
	SlotID     int64  `json:"slot_id"`
	StartTime  string `json:"start_time"`
	GroupID    int64  `json:"group_id"`
}

// orderedSet is a set of ids that remembers insertion order.
type orderedSet struct {
	items []int64
	index map[int64]bool
}

func newOrderedSet() *orderedSet { return &orderedSet{index: map[int64]bool{}} }

func (o *orderedSet) add(id int64) {
	if !o.index[id] {
		o.index[id] = true
		o.items = append(o.items, id)
	}
}

func (o *orderedSet) delete(id int64) {
	if o.index[id] {
		delete(o.index, id)
		o.items = slices.DeleteFunc(o.items, func(x int64) bool { return x == id })
	}
}

func (o *orderedSet) has(id int64) bool { return o.index[id] }
func (o *orderedSet) size() int         { return len(o.items) }

type placementContext struct {
	groupID              int64
	candidateRank        int
	candidatesConsidered int
	groupQuota           string
	buddyOf              string
	overflow             bool
}

type batchLog struct {
	Trigger              string   `json:"trigger"`
	LastTurnAt           *string  `json:"last_turn_at"`
	InviteNext           bool     `json:"invite_next"`
	CandidateRank        int      `json:"candidate_rank"`
	CandidatesConsidered int      `json:"candidates_considered"`
	GroupName            *string  `json:"group_name"`
	GroupColor           *string  `json:"group_color"`
	GroupQuota           *string  `json:"group_quota"`
	PreferredTimeslots   []string `json:"preferred_timeslots"`
	PreferredDays        []int    `json:"preferred_days"`
	BuddyPlacedNear      *string  `json:"buddy_placed_near"`
	Overflow             bool     `json:"overflow"`
}

type gridSpot struct {
	timeslot     Timeslot
	slotID       int64
	timeslotIdx  int
	instructorID int64
}

func (s *Server) handleGenerateSchedule(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	if st := session.Status; st != "draft" && st != "scheduled" {
		httpx.Error(w, http.StatusBadRequest, "A schedule can only be generated before invitations are sent")
		return nil
	}
	id := r.PathValue("id")
	sessionID := session.ID
	if session.TimetableID == nil || *session.TimetableID == 0 {
		httpx.Error(w, http.StatusBadRequest, "No timetable attached to this session")
		return nil
	}
	timetableID := *session.TimetableID
	var instructorCount int64
	if err := s.db.QueryRow("SELECT COUNT(*) FROM session_slots WHERE session_id = ? AND removed = 0", id).Scan(&instructorCount); err != nil {
		return err
	}
	if instructorCount == 0 {
		httpx.Error(w, http.StatusBadRequest, "No instructors assigned for this session")
		return nil
	}
	timeslots, err := s.timetableTimeslots(timetableID)
	if err != nil {
		return err
	}
	if len(timeslots) == 0 {
		httpx.Error(w, http.StatusBadRequest, "No timeslots defined in the attached timetable")
		return nil
	}
	totalSlots := len(timeslots) * int(instructorCount)

	// Manually-added invitations (group_id IS NULL) are kept; auto-generated ones are redone.
	type manualInvitation struct {
		TimeslotID int64 `db:"timeslot_id"`
		SlotID     int64 `db:"slot_id"`
	}
	manual, err := db.Many[manualInvitation](s.db, "SELECT timeslot_id, slot_id FROM invitations WHERE session_id = ? AND group_id IS NULL", id)
	if err != nil {
		return err
	}
	availableSlots := totalSlots - len(manual)

	timetableGroups, err := s.timetableGroups(timetableID)
	if err != nil {
		return err
	}
	if len(timetableGroups) == 0 {
		httpx.Error(w, http.StatusBadRequest, "No groups assigned to this timetable")
		return nil
	}

	// Slots per group from percentages; the remainder goes one each to the first groups.
	type groupSlots struct {
		groupID int64
		slots   int
	}
	var groupSlotCounts []*groupSlots
	allocated := 0
	percentage := map[int64]float64{}
	groupName, groupColor := map[int64]string{}, map[int64]string{}
	for _, tg := range timetableGroups {
		gid, pct := tg.GroupID, tg.Percentage
		n := int(math.Floor(float64(availableSlots) * float64(pct) / 100))
		groupSlotCounts = append(groupSlotCounts, &groupSlots{gid, n})
		allocated += n
		percentage[gid] = float64(pct)
		groupName[gid], groupColor[gid] = tg.GroupName, tg.GroupColor
	}
	remainder := availableSlots - allocated
	for _, g := range groupSlotCounts {
		if remainder <= 0 {
			break
		}
		g.slots++
		remainder--
	}

	// Students of the timetable's groups that have an active discipline.
	sessionDate := session.Date
	dow := "NaN"
	if d, ok := dayOfWeek(sessionDate); ok {
		dow = strconv.Itoa(d)
	}
	eligibleWhere := `
		WHERE s.active = 1
			AND s.deleted_at IS NULL
			AND sg.group_id IN (SELECT group_id FROM timetable_groups WHERE timetable_id = ?)
			AND EXISTS (
				SELECT 1 FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id
				WHERE dg.group_id = sg.group_id AND d.active = 1
			)
			AND ('|' || s.preferred_days || '|') LIKE '%|' || ? || '|%'
			AND (s.cooldown_until IS NULL OR date(s.cooldown_until) <= ?)
			AND s.id NOT IN (SELECT student_id FROM invitations WHERE session_id = ? AND group_id IS NULL)
			AND s.id NOT IN (
				SELECT inv.student_id FROM invitations inv
				JOIN training_sessions ts ON ts.id = inv.session_id
				WHERE ts.date = ? AND inv.status NOT IN ` + terminalStatuses + `
					AND NOT (inv.session_id = ? AND inv.group_id IS NOT NULL) -- auto-generated ones are redone
			)`
	eligibleArgs := []any{timetableID, dow, sessionDate, id, sessionDate, id}

	// Every check that can fail runs before the current schedule is touched, so a failed
	// regeneration leaves it in place.
	if len(manual) == 0 {
		var n int64
		if err := s.db.QueryRow("SELECT COUNT(*) FROM students s JOIN student_groups sg ON sg.student_id = s.id"+eligibleWhere, eligibleArgs...).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			httpx.Error(w, http.StatusBadRequest, "No eligible students found. Ensure students have group memberships with access to disciplines.")
			return nil
		}
	}

	// The auto-generated invitations go before the queue is read: as counted invitations they
	// would otherwise make everyone in the current schedule look like they just had a turn.
	if _, err := s.db.Exec("DELETE FROM invitations WHERE session_id = ? AND group_id IS NOT NULL", id); err != nil {
		return err
	}
	eligible, err := s.queueCandidates(eligibleWhere+`
		ORDER BY `+queue.OrderSQL, eligibleArgs...)
	if err != nil {
		return err
	}
	eligible = queue.BreakTies(eligible, sessionID)

	studentsByGroup := map[int64][]candidate{}
	for _, g := range groupSlotCounts {
		studentsByGroup[g.groupID] = []candidate{}
	}
	for _, st := range eligible {
		studentsByGroup[st.GroupID] = append(studentsByGroup[st.GroupID], st)
	}

	type assignedInstructor struct {
		ID     int64 `db:"id"`
		SlotID int64 `db:"slot_id"`
	}
	instructors, err := db.Many[assignedInstructor](s.db, `
		SELECT i.id, ss.id AS slot_id FROM instructors i
		JOIN session_slots ss ON ss.instructor_id = i.id
		WHERE ss.session_id = ? AND ss.removed = 0
		ORDER BY i.last_name ASC, i.first_name ASC`, id)
	if err != nil {
		return err
	}

	// Grid of spots: every timeslot has one spot per instructor.
	var grid []gridSpot
	for ti, ts := range timeslots {
		for _, in := range instructors {
			grid = append(grid, gridSpot{timeslot: ts, slotID: in.SlotID, timeslotIdx: ti, instructorID: in.ID})
		}
	}
	available := make([]bool, len(grid))
	for i := range available {
		available[i] = true
	}
	for _, mi := range manual {
		for i, spot := range grid {
			if spot.timeslot.ID == mi.TimeslotID && spot.slotID == mi.SlotID {
				available[i] = false
				break
			}
		}
	}

	prefs, err := s.prefsByStudent(timetableID)
	if err != nil {
		return err
	}

	// Buddies: for each student the other members of their buddy group, in insertion order.
	type buddyMembership struct {
		BuddyGroupID int64 `db:"buddy_group_id"`
		StudentID    int64 `db:"student_id"`
	}
	buddyMemberships, err := db.Many[buddyMembership](s.db, "SELECT bgm.buddy_group_id, bgm.student_id FROM buddy_group_members bgm")
	if err != nil {
		return err
	}
	var buddyGroupOrder []int64
	buddyGroups := map[int64]*orderedSet{}
	for _, m := range buddyMemberships {
		if buddyGroups[m.BuddyGroupID] == nil {
			buddyGroups[m.BuddyGroupID] = newOrderedSet()
			buddyGroupOrder = append(buddyGroupOrder, m.BuddyGroupID)
		}
		buddyGroups[m.BuddyGroupID].add(m.StudentID)
	}
	buddiesOf := map[int64]*orderedSet{}
	for _, bg := range buddyGroupOrder {
		members := buddyGroups[bg]
		for _, sid := range members.items {
			if buddiesOf[sid] == nil {
				buddiesOf[sid] = newOrderedSet()
			}
			for _, other := range members.items {
				if other != sid {
					buddiesOf[sid].add(other)
				}
			}
		}
	}

	// ----- Timeslot matching -----
	// Students are matched to a timeslot first (capacity = free spots); spots are assigned afterwards.
	capacity := make([]int, len(timeslots))
	for i, spot := range grid {
		if available[i] {
			capacity[spot.timeslotIdx]++
		}
	}
	occupants := make([]*orderedSet, len(timeslots))
	for i := range occupants {
		occupants[i] = newOrderedSet()
	}
	placedTimeslot := map[int64]int{}

	allowedCache := map[int64][]int{}
	allowedTimeslots := func(sid int64) []int {
		if a, ok := allowedCache[sid]; ok {
			return a
		}
		p := prefs[sid]
		a := []int{}
		for i, ts := range timeslots {
			if len(p) == 0 || p[ts.ID] {
				a = append(a, i)
			}
		}
		allowedCache[sid] = a
		return a
	}
	hasTimeslotPreference := func(sid int64) bool { return len(allowedTimeslots(sid)) < len(timeslots) }

	putInTimeslot := func(sid int64, ti int) {
		if prev, ok := placedTimeslot[sid]; ok {
			occupants[prev].delete(sid)
		}
		occupants[ti].add(sid)
		placedTimeslot[sid] = ti
	}

	// Allowed timeslots closest to the anchor first; earliest first without an anchor.
	orderedTimeslots := func(sid int64, anchor int, hasAnchor bool) []int {
		allowed := allowedTimeslots(sid)
		if !hasAnchor {
			return allowed
		}
		out := slices.Clone(allowed)
		abs := func(x int) int { return max(x, -x) }
		sort.SliceStable(out, func(i, j int) bool {
			di, dj := abs(out[i]-anchor), abs(out[j]-anchor)
			if di != dj {
				return di < dj
			}
			return out[i] < out[j]
		})
		return out
	}

	// Augmenting path: may move already-placed students to another allowed timeslot, but never unplaces them.
	var tryPlace func(sid int64, order []int, visited map[int]bool) bool
	tryPlace = func(sid int64, order []int, visited map[int]bool) bool {
		for _, ti := range order {
			if !visited[ti] && occupants[ti].size() < capacity[ti] {
				putInTimeslot(sid, ti)
				return true
			}
		}
		for _, ti := range order {
			if visited[ti] {
				continue
			}
			visited[ti] = true
			for _, other := range slices.Clone(occupants[ti].items) {
				if other != sid && tryPlace(other, orderedTimeslots(other, ti, true), visited) {
					putInTimeslot(sid, ti)
					return true
				}
			}
		}
		return false
	}

	placeStudent := func(sid int64) bool {
		anchor, hasAnchor := 0, false
		if b := buddiesOf[sid]; b != nil {
			for _, buddy := range b.items {
				if ti, ok := placedTimeslot[buddy]; ok {
					anchor, hasAnchor = ti, true
					break
				}
			}
		}
		return tryPlace(sid, orderedTimeslots(sid, anchor, hasAnchor), map[int]bool{})
	}

	// ----- Selection: top n per group (n = quota), buddies pulled up within the same group -----
	contexts := map[int64]*placementContext{}
	quotaLabel := map[int64]string{}
	for _, g := range groupSlotCounts {
		quotaLabel[g.groupID] = fmt.Sprintf("%d slots (%d%%)", g.slots, int64(percentage[g.groupID]))
	}
	groupContext := func(st candidate, gid int64, buddyOf string) *placementContext {
		list := studentsByGroup[gid]
		rank := slices.IndexFunc(list, func(x candidate) bool { return x.ID == st.ID }) + 1
		return &placementContext{groupID: gid, candidateRank: rank, candidatesConsidered: len(list), groupQuota: quotaLabel[gid], buddyOf: buddyOf}
	}

	var selected []candidate
	remainingByGroup := map[int64][]candidate{}
	for _, g := range groupSlotCounts {
		list := studentsByGroup[g.groupID]
		taken := map[int64]bool{}
		sel := func(st candidate, buddyOf string) {
			taken[st.ID] = true
			selected = append(selected, st)
			contexts[st.ID] = groupContext(st, g.groupID, buddyOf)
		}
		for _, st := range list {
			if len(taken) >= g.slots {
				break
			}
			if taken[st.ID] {
				continue
			}
			sel(st, "")
			buddies := buddiesOf[st.ID]
			if buddies == nil {
				continue
			}
			for _, buddy := range list {
				if len(taken) >= g.slots {
					break
				}
				if buddies.has(buddy.ID) && !taken[buddy.ID] {
					sel(buddy, st.FirstName+" "+st.LastName)
				}
			}
		}
		rest := []candidate{}
		for _, st := range list {
			if !taken[st.ID] {
				rest = append(rest, st)
			}
		}
		remainingByGroup[g.groupID] = rest
	}

	// ----- Placement -----
	queueIndex := map[int64]int{}
	for i, st := range eligible {
		queueIndex[st.ID] = i
	}
	byQueue := func(list []candidate) {
		sort.SliceStable(list, func(i, j int) bool { return queueIndex[list[i].ID] < queueIndex[list[j].ID] })
	}
	var withPreference, withoutPreference []candidate
	for _, st := range selected {
		if hasTimeslotPreference(st.ID) {
			withPreference = append(withPreference, st)
		} else {
			withoutPreference = append(withoutPreference, st)
		}
	}
	byQueue(withPreference)
	byQueue(withoutPreference)
	var placed []candidate
	// Placing more students never frees room, so a student who failed once can't be placed later.
	unplaceable := map[int64]bool{}

	// Phase 1: students with timeslot preferences; an unplaceable one is replaced by the next candidate of its group.
	for len(withPreference) > 0 {
		st := withPreference[0]
		withPreference = withPreference[1:]
		if placeStudent(st.ID) {
			placed = append(placed, st)
			continue
		}
		unplaceable[st.ID] = true
		gid := contexts[st.ID].groupID
		delete(contexts, st.ID)
		rest := remainingByGroup[gid]
		if len(rest) == 0 {
			continue
		}
		repl := rest[0]
		remainingByGroup[gid] = rest[1:]
		contexts[repl.ID] = groupContext(repl, gid, "")
		if hasTimeslotPreference(repl.ID) {
			withPreference = append(withPreference, repl)
		} else {
			withoutPreference = append(withoutPreference, repl)
		}
	}

	// Phase 2: students without preferences fill the remaining spots.
	for _, st := range withoutPreference {
		if placeStudent(st.ID) {
			placed = append(placed, st)
		} else {
			delete(contexts, st.ID)
			unplaceable[st.ID] = true
		}
	}

	// Phase 3 (overflow): remaining spots go to uninvited eligible students of any group. Each
	// pick chooses a group at random (weighted by timetable percentage) and tries its first candidate.
	totalCapacity := 0
	for _, c := range capacity {
		totalCapacity += c
	}
	var overflowCandidates []candidate
	for _, st := range eligible {
		if _, isPlaced := placedTimeslot[st.ID]; !isPlaced && !unplaceable[st.ID] {
			overflowCandidates = append(overflowCandidates, st)
		}
	}
	var overflowOrder []int64
	overflowQueues := map[int64][]candidate{}
	for _, st := range overflowCandidates {
		if _, ok := overflowQueues[st.GroupID]; !ok {
			overflowOrder = append(overflowOrder, st.GroupID)
		}
		overflowQueues[st.GroupID] = append(overflowQueues[st.GroupID], st)
	}
	// Seeded by session so regenerating the same session yields the same overflow picks.
	random := mrand.New(mrand.NewPCG(uint64(sessionID), 0)).Float64
	overflowRank := 0
	for len(overflowOrder) > 0 && len(placedTimeslot) < totalCapacity {
		picked := queue.WeightedPickGroup(overflowOrder, percentage, random)
		q := overflowQueues[picked]
		st := q[0]
		if len(q) == 1 {
			delete(overflowQueues, picked)
			overflowOrder = slices.DeleteFunc(overflowOrder, func(g int64) bool { return g == picked })
		} else {
			overflowQueues[picked] = q[1:]
		}
		overflowRank++
		if !placeStudent(st.ID) {
			continue
		}
		placed = append(placed, st)
		contexts[st.ID] = &placementContext{groupID: picked, candidateRank: overflowRank, candidatesConsidered: len(overflowCandidates), overflow: true}
	}

	clubDays := db.Setting(s.db, "club_days", "0|1|2|3|4|5|6")

	// Each placed student gets the first free instructor spot of their matched timeslot.
	invited := []ScheduledInvitation{}
	err = s.db.InTx(func(tx *sqlx.Tx) error {
		for _, st := range placed {
			ctx := contexts[st.ID]
			ti := placedTimeslot[st.ID]
			spotIdx := -1
			for i, spot := range grid {
				if available[i] && spot.timeslotIdx == ti {
					spotIdx = i
					break
				}
			}
			available[spotIdx] = false
			spot := grid[spotIdx]
			token := newToken()

			decisionLog := encodeJSON(batchLog{
				Trigger:              "batch_schedule",
				LastTurnAt:           st.LastTurnAt,
				InviteNext:           st.InviteNextSince != nil,
				CandidateRank:        ctx.candidateRank,
				CandidatesConsidered: ctx.candidatesConsidered,
				GroupName:            nonEmpty(groupName[ctx.groupID]),
				GroupColor:           nonEmpty(groupColor[ctx.groupID]),
				GroupQuota:           nonEmpty(ctx.groupQuota),
				PreferredTimeslots:   preferredStartTimes(prefs[st.ID], timeslots),
				PreferredDays:        preferredDays(st.PreferredDays, clubDays),
				BuddyPlacedNear:      nonEmpty(ctx.buddyOf),
				Overflow:             ctx.overflow,
			})
			if _, err := tx.Exec(`
				INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token, group_id, decision_log)
				VALUES (?, ?, ?, ?, ?, ?, ?)`, id, st.ID, spot.timeslot.ID, spot.slotID, token, ctx.groupID, decisionLog); err != nil {
				return err
			}
			invited = append(invited, ScheduledInvitation{
				StudentID: st.ID, FirstName: st.FirstName, LastName: st.LastName, Token: token,
				TimeslotID: spot.timeslot.ID, SlotID: spot.slotID, StartTime: spot.timeslot.StartTime, GroupID: ctx.groupID,
			})
		}
		return nil
	})
	if err != nil {
		return err
	}

	if _, err := s.db.Exec("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?", id); err != nil {
		return err
	}
	s.hub.BroadcastSession(sessionID, "reload", map[string]any{})
	s.broadcastSessionCounts(sessionID)

	httpx.OK(w, map[string]any{
		"session_id":       id,
		"total_slots":      totalSlots,
		"students_invited": len(invited) + len(manual),
		"invitations":      invited,
	})
	return nil
}
