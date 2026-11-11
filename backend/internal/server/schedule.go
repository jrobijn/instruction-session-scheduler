package server

import (
	"fmt"
	"net/http"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/scheduling"
)

// POST /api/sessions/:id/generate-schedule. Who is invited where is decided by
// scheduling.Generate; this handler loads its input, assigns instructor spots and writes the
// invitations.

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

type gridSpot struct {
	timeslot    Timeslot
	slotID      int64
	timeslotIdx int
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

	timetableGroups, err := s.timetableGroups(timetableID)
	if err != nil {
		return err
	}
	if len(timetableGroups) == 0 {
		httpx.Error(w, http.StatusBadRequest, "No groups assigned to this timetable")
		return nil
	}
	groupName, groupColor := map[int64]string{}, map[int64]string{}
	for _, tg := range timetableGroups {
		groupName[tg.GroupID], groupColor[tg.GroupID] = tg.GroupName, tg.GroupColor
	}
	groups := scheduling.AllocateSlots(totalSlots-len(manual), schedulingGroups(timetableGroups))
	quotaLabel := map[int64]string{}
	for _, g := range groups {
		quotaLabel[g.ID] = fmt.Sprintf("%d slots (%d%%)", g.Slots, int64(g.Percentage))
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

	// Grid of spots: every timeslot has one spot per instructor. Spots of manual invitations
	// are taken.
	var grid []gridSpot
	for ti, ts := range timeslots {
		for _, in := range instructors {
			grid = append(grid, gridSpot{timeslot: ts, slotID: in.SlotID, timeslotIdx: ti})
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
	timeslotCapacity := make([]scheduling.Timeslot, len(timeslots))
	for i, ts := range timeslots {
		timeslotCapacity[i].ID = ts.ID
	}
	for i, spot := range grid {
		if available[i] {
			timeslotCapacity[spot.timeslotIdx].Capacity++
		}
	}

	prefs, err := s.timeslotPrefs(timetableID)
	if err != nil {
		return err
	}
	buddies, err := s.loadBuddies()
	if err != nil {
		return err
	}
	clubDays := db.Setting(s.db, "club_days", "0|1|2|3|4|5|6")
	loc := s.clubLocation()

	// From here on everything runs in one transaction, so a failed regeneration leaves the
	// current schedule in place. No queries on s.db until it is committed (see db.Open).
	tx, err := s.db.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after Commit

	// The auto-generated invitations go before the queue is read: as counted invitations they
	// would otherwise make everyone in the current schedule look like they just had a turn.
	if _, err := tx.Exec("DELETE FROM invitations WHERE session_id = ? AND group_id IS NOT NULL", id); err != nil {
		return err
	}
	eligible, err := eligibleQueue(tx, loc, sessionID, session.Date, timetableID)
	if err != nil {
		return err
	}
	if len(eligible) == 0 && len(manual) == 0 {
		httpx.Error(w, http.StatusBadRequest, "No eligible students found. Ensure students have group memberships with access to disciplines.")
		return nil
	}

	placements := scheduling.Generate(scheduling.Input{
		Queue:     eligible,
		Groups:    groups,
		Timeslots: timeslotCapacity,
		Allows:    prefs.allows,
		Buddies:   buddies,
		Seed:      sessionID, // regenerating the same session yields the same overflow picks
	})

	// Each placed student gets the first free instructor spot of their timeslot.
	invited := []ScheduledInvitation{}
	for _, p := range placements {
		st := p.Member
		spotIdx := -1
		for i, spot := range grid {
			if available[i] && spot.timeslotIdx == p.Timeslot {
				spotIdx = i
				break
			}
		}
		available[spotIdx] = false
		spot := grid[spotIdx]
		token := newToken()

		var quota, buddyOf string
		if !p.Overflow {
			quota = quotaLabel[p.GroupID]
		}
		if p.PulledUpBy != nil {
			buddyOf = p.PulledUpBy.FirstName + " " + p.PulledUpBy.LastName
		}
		decisionLog := encodeJSON(batchLog{
			candidateLog: candidateLog{
				Trigger:              "batch_schedule",
				CandidateRank:        p.Rank,
				CandidatesConsidered: p.Considered,
				GroupName:            nonEmpty(groupName[p.GroupID]),
				GroupColor:           nonEmpty(groupColor[p.GroupID]),
				BuddyPlacedNear:      nonEmpty(buddyOf),
			}.withStudent(st, prefs.startTimes(st.ID, timeslots), clubDays),
			GroupQuota: nonEmpty(quota),
			Overflow:   p.Overflow,
		})
		if _, err := tx.Exec(`
			INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token, group_id, decision_log)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, id, st.ID, spot.timeslot.ID, spot.slotID, token, p.GroupID, decisionLog); err != nil {
			return err
		}
		invited = append(invited, ScheduledInvitation{
			StudentID: st.ID, FirstName: st.FirstName, LastName: st.LastName, Token: token,
			TimeslotID: spot.timeslot.ID, SlotID: spot.slotID, StartTime: spot.timeslot.StartTime, GroupID: p.GroupID,
		})
	}

	if _, err := tx.Exec("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?", id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
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
