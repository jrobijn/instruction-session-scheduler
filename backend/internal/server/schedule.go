package server

import (
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"slices"
	"sort"
	"strconv"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// POST /api/sessions/:id/generate-schedule. Iteration orders of the former TypeScript
// implementation (JS Map/Set insertion order, stable sorts) are reproduced exactly: they decide who gets moved or placed.

type student map[string]any

func (st student) id() int64      { return toInt64(st["id"]) }
func (st student) QueueID() int64 { return st.id() }
func (st student) QueueTieKey() string {
	return queue.TieKey(strPtr(st["invite_next_since"]), str(st, "queue_at"))
}

func strPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

// orderedSet is a JS Set of ids: membership plus insertion order.
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
	Trigger              string `json:"trigger"`
	LastTurnAt           any    `json:"last_turn_at"`
	InviteNext           bool   `json:"invite_next"`
	CandidateRank        int    `json:"candidate_rank"`
	CandidatesConsidered int    `json:"candidates_considered"`
	GroupName            any    `json:"group_name"`
	GroupColor           any    `json:"group_color"`
	GroupQuota           any    `json:"group_quota"`
	PreferredTimeslots   any    `json:"preferred_timeslots"`
	PreferredDays        any    `json:"preferred_days"`
	BuddyPlacedNear      any    `json:"buddy_placed_near"`
	Overflow             bool   `json:"overflow"`
}

type gridSpot struct {
	timeslot     map[string]any
	slotID       int64
	timeslotIdx  int
	instructorID int64
}

func (s *Server) handleGenerateSchedule(w http.ResponseWriter, r *http.Request) error {
	session, ok, err := s.loadSession(w, r)
	if !ok || err != nil {
		return err
	}
	if st := session["status"]; st != "draft" && st != "scheduled" {
		httpx.Error(w, http.StatusBadRequest, "A schedule can only be generated before invitations are sent")
		return nil
	}
	id := r.PathValue("id")
	sessionID := toInt64(session["id"])
	timetableID := session["timetable_id"]
	if !truthy(timetableID) {
		httpx.Error(w, http.StatusBadRequest, "No timetable attached to this session")
		return nil
	}
	var instructorCount int64
	if err := s.db.QueryRow("SELECT COUNT(*) FROM session_slots WHERE session_id = ? AND removed = 0", id).Scan(&instructorCount); err != nil {
		return err
	}
	if instructorCount == 0 {
		httpx.Error(w, http.StatusBadRequest, "No instructors assigned for this session")
		return nil
	}
	timeslots, err := db.All(s.db, "SELECT * FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC", timetableID)
	if err != nil {
		return err
	}
	if len(timeslots) == 0 {
		httpx.Error(w, http.StatusBadRequest, "No timeslots defined in the attached timetable")
		return nil
	}
	totalSlots := len(timeslots) * int(instructorCount)

	// Manually-added invitations (group_id IS NULL) are kept; auto-generated ones are redone.
	manual, err := db.All(s.db, "SELECT * FROM invitations WHERE session_id = ? AND group_id IS NULL", id)
	if err != nil {
		return err
	}
	availableSlots := totalSlots - len(manual)

	timetableGroups, err := db.All(s.db, `
		SELECT tg.group_id, tg.percentage, g.name AS group_name, g.color AS group_color
		FROM timetable_groups tg
		JOIN groups g ON g.id = tg.group_id
		WHERE tg.timetable_id = ?
		ORDER BY tg.position ASC`, timetableID)
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
	groupName, groupColor := map[int64]any{}, map[int64]any{}
	for _, tg := range timetableGroups {
		gid, pct := toInt64(tg["group_id"]), toInt64(tg["percentage"])
		n := int(math.Floor(float64(availableSlots) * float64(pct) / 100))
		groupSlotCounts = append(groupSlotCounts, &groupSlots{gid, n})
		allocated += n
		percentage[gid] = float64(pct)
		groupName[gid], groupColor[gid] = tg["group_name"], tg["group_color"]
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
	sessionDate := str(session, "date")
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
	rows, err := db.All(s.db, `
		SELECT s.*, sg.group_id AS group_id, `+queue.ColumnsSQL+` FROM students s
		JOIN student_groups sg ON sg.student_id = s.id
		`+queue.JoinSQL+eligibleWhere+`
		ORDER BY `+queue.OrderSQL, eligibleArgs...)
	if err != nil {
		return err
	}
	eligible := make([]student, len(rows))
	for i, row := range rows {
		eligible[i] = student(row)
	}
	eligible = queue.BreakTies(eligible, sessionID)

	studentsByGroup := map[int64][]student{}
	for _, g := range groupSlotCounts {
		studentsByGroup[g.groupID] = []student{}
	}
	for _, st := range eligible {
		gid := toInt64(st["group_id"])
		studentsByGroup[gid] = append(studentsByGroup[gid], st)
	}

	instructors, err := db.All(s.db, `
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
			grid = append(grid, gridSpot{timeslot: ts, slotID: toInt64(in["slot_id"]), timeslotIdx: ti, instructorID: toInt64(in["id"])})
		}
	}
	available := make([]bool, len(grid))
	for i := range available {
		available[i] = true
	}
	for _, mi := range manual {
		for i, spot := range grid {
			if toInt64(spot.timeslot["id"]) == toInt64(mi["timeslot_id"]) && spot.slotID == toInt64(mi["slot_id"]) {
				available[i] = false
				break
			}
		}
	}

	prefs, err := s.prefsByStudent(timetableID)
	if err != nil {
		return err
	}

	// Buddies: for each student the other members of their buddy group, in JS Map/Set order.
	buddyRows, err := db.All(s.db, "SELECT bgm.buddy_group_id, bgm.student_id FROM buddy_group_members bgm")
	if err != nil {
		return err
	}
	var buddyGroupOrder []int64
	buddyGroups := map[int64]*orderedSet{}
	for _, m := range buddyRows {
		bg := toInt64(m["buddy_group_id"])
		if buddyGroups[bg] == nil {
			buddyGroups[bg] = newOrderedSet()
			buddyGroupOrder = append(buddyGroupOrder, bg)
		}
		buddyGroups[bg].add(toInt64(m["student_id"]))
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
			if len(p) == 0 || p[toInt64(ts["id"])] {
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
		quotaLabel[g.groupID] = fmt.Sprintf("%d slots (%s%%)", g.slots, jsString(percentage[g.groupID]))
	}
	groupContext := func(st student, gid int64, buddyOf string) *placementContext {
		list := studentsByGroup[gid]
		rank := slices.IndexFunc(list, func(x student) bool { return x.id() == st.id() }) + 1
		return &placementContext{groupID: gid, candidateRank: rank, candidatesConsidered: len(list), groupQuota: quotaLabel[gid], buddyOf: buddyOf}
	}

	var selected []student
	remainingByGroup := map[int64][]student{}
	for _, g := range groupSlotCounts {
		list := studentsByGroup[g.groupID]
		taken := map[int64]bool{}
		sel := func(st student, buddyOf string) {
			taken[st.id()] = true
			selected = append(selected, st)
			contexts[st.id()] = groupContext(st, g.groupID, buddyOf)
		}
		for _, st := range list {
			if len(taken) >= g.slots {
				break
			}
			if taken[st.id()] {
				continue
			}
			sel(st, "")
			buddies := buddiesOf[st.id()]
			if buddies == nil {
				continue
			}
			for _, buddy := range list {
				if len(taken) >= g.slots {
					break
				}
				if buddies.has(buddy.id()) && !taken[buddy.id()] {
					sel(buddy, str(st, "first_name")+" "+str(st, "last_name"))
				}
			}
		}
		rest := []student{}
		for _, st := range list {
			if !taken[st.id()] {
				rest = append(rest, st)
			}
		}
		remainingByGroup[g.groupID] = rest
	}

	// ----- Placement -----
	queueIndex := map[int64]int{}
	for i, st := range eligible {
		queueIndex[st.id()] = i
	}
	byQueue := func(list []student) {
		sort.SliceStable(list, func(i, j int) bool { return queueIndex[list[i].id()] < queueIndex[list[j].id()] })
	}
	var withPreference, withoutPreference []student
	for _, st := range selected {
		if hasTimeslotPreference(st.id()) {
			withPreference = append(withPreference, st)
		} else {
			withoutPreference = append(withoutPreference, st)
		}
	}
	byQueue(withPreference)
	byQueue(withoutPreference)
	var placed []student
	// Placing more students never frees room, so a student who failed once can't be placed later.
	unplaceable := map[int64]bool{}

	// Phase 1: students with timeslot preferences; an unplaceable one is replaced by the next candidate of its group.
	for len(withPreference) > 0 {
		st := withPreference[0]
		withPreference = withPreference[1:]
		if placeStudent(st.id()) {
			placed = append(placed, st)
			continue
		}
		unplaceable[st.id()] = true
		gid := contexts[st.id()].groupID
		delete(contexts, st.id())
		rest := remainingByGroup[gid]
		if len(rest) == 0 {
			continue
		}
		repl := rest[0]
		remainingByGroup[gid] = rest[1:]
		contexts[repl.id()] = groupContext(repl, gid, "")
		if hasTimeslotPreference(repl.id()) {
			withPreference = append(withPreference, repl)
		} else {
			withoutPreference = append(withoutPreference, repl)
		}
	}

	// Phase 2: students without preferences fill the remaining spots.
	for _, st := range withoutPreference {
		if placeStudent(st.id()) {
			placed = append(placed, st)
		} else {
			delete(contexts, st.id())
			unplaceable[st.id()] = true
		}
	}

	// Phase 3 (overflow): remaining spots go to uninvited eligible students of any group. Each
	// pick chooses a group at random (weighted by timetable percentage) and tries its first candidate.
	totalCapacity := 0
	for _, c := range capacity {
		totalCapacity += c
	}
	var overflowCandidates []student
	for _, st := range eligible {
		if _, isPlaced := placedTimeslot[st.id()]; !isPlaced && !unplaceable[st.id()] {
			overflowCandidates = append(overflowCandidates, st)
		}
	}
	var overflowOrder []int64
	overflowQueues := map[int64][]student{}
	for _, st := range overflowCandidates {
		gid := toInt64(st["group_id"])
		if _, ok := overflowQueues[gid]; !ok {
			overflowOrder = append(overflowOrder, gid)
		}
		overflowQueues[gid] = append(overflowQueues[gid], st)
	}
	random := queue.SeededRandom(sessionID)
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
		if !placeStudent(st.id()) {
			continue
		}
		placed = append(placed, st)
		contexts[st.id()] = &placementContext{groupID: picked, candidateRank: overflowRank, candidatesConsidered: len(overflowCandidates), overflow: true}
	}

	clubDays := db.Setting(s.db, "club_days", "0|1|2|3|4|5|6")

	// Each placed student gets the first free instructor spot of their matched timeslot.
	invited := []map[string]any{}
	err = s.db.InTx(func(tx *sql.Tx) error {
		for _, st := range placed {
			ctx := contexts[st.id()]
			ti := placedTimeslot[st.id()]
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

			var preferredTimeslots any
			if p := prefs[st.id()]; len(p) > 0 {
				list := []any{}
				for _, ts := range timeslots {
					if p[toInt64(ts["id"])] {
						list = append(list, ts["start_time"])
					}
				}
				preferredTimeslots = list
			}
			var quota, buddyOf any
			if ctx.groupQuota != "" {
				quota = ctx.groupQuota
			}
			if ctx.buddyOf != "" {
				buddyOf = ctx.buddyOf
			}
			decisionLog := marshalJS(batchLog{
				Trigger:              "batch_schedule",
				LastTurnAt:           st["last_turn_at"],
				InviteNext:           st["invite_next_since"] != nil,
				CandidateRank:        ctx.candidateRank,
				CandidatesConsidered: ctx.candidatesConsidered,
				GroupName:            orNull(groupName[ctx.groupID]),
				GroupColor:           orNull(groupColor[ctx.groupID]),
				GroupQuota:           quota,
				PreferredTimeslots:   preferredTimeslots,
				PreferredDays:        nilIfEmpty(preferredDays(str(st, "preferred_days"), clubDays)),
				BuddyPlacedNear:      buddyOf,
				Overflow:             ctx.overflow,
			})
			timeslotID := toInt64(spot.timeslot["id"])
			if _, err := tx.Exec(`
				INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token, group_id, decision_log)
				VALUES (?, ?, ?, ?, ?, ?, ?)`, id, st.id(), timeslotID, spot.slotID, token, ctx.groupID, decisionLog); err != nil {
				return err
			}
			out := map[string]any{}
			for k, v := range st {
				out[k] = v
			}
			out["token"] = token
			out["timeslot_id"] = timeslotID
			out["slot_id"] = spot.slotID
			out["start_time"] = spot.timeslot["start_time"]
			out["group_id"] = ctx.groupID
			out["timeslotIdx"] = spot.timeslotIdx
			invited = append(invited, out)
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
