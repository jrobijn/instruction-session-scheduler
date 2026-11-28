package server

import (
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/scheduling"
)

// POST /api/sessions/:id/generate-schedule and GET /api/sessions/:id/schedule-preview. Who is
// invited where is decided by scheduling.Generate; planSchedule loads its input and assigns
// instructor spots. Generating writes the plan as invitations; previewing shows each group's
// queue for the session with who the plan invites, and writes nothing, so it shows exactly
// what generating would do at that moment.

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

// schedulePlan is what generating a session's schedule would do.
type schedulePlan struct {
	totalSlots  int
	manual      int // manually-added invitations, which are kept
	invitations []plannedInvitation

	// quotas are the timetable's groups with their slots; skipped the students up for a spot
	// who could not be placed (see scheduling.Result).
	quotas  []scheduling.Group
	skipped []queue.Member
}

// plannedInvitation is a student placed in a free instructor spot of a timeslot.
type plannedInvitation struct {
	placement scheduling.Placement
	timeslot  Timeslot
	slotID    int64
	log       batchLog
}

// planSchedule plans the schedule of session, which must pass unschedulable. It first deletes
// the session's auto-generated invitations, as regenerating replaces them: the caller commits
// tx to keep the plan, or rolls it back to only look at it. problem is a message for a 400
// when the session can't be scheduled. loc and clubDays are the club's settings (look them up
// before starting tx; see Server.clubLocation).
func planSchedule(tx *sqlx.Tx, session Session, loc *time.Location, clubDays string) (plan schedulePlan, problem string, err error) {
	timetableID := *session.TimetableID
	instructorCount, err := db.Get[int64](tx, "SELECT COUNT(*) FROM session_slots WHERE session_id = ? AND removed = 0", session.ID)
	if err != nil {
		return plan, "", err
	}

	if instructorCount == 0 {
		return plan, "No instructors assigned for this session", nil
	}

	timeslots, err := timetableTimeslots(tx, timetableID)
	if err != nil {
		return plan, "", err
	}

	if len(timeslots) == 0 {
		return plan, "No timeslots defined in the attached timetable", nil
	}

	plan.totalSlots = len(timeslots) * int(instructorCount)

	// Manually-added invitations (group_id IS NULL) are kept; auto-generated ones are redone.
	type manualInvitation struct {
		TimeslotID int64 `db:"timeslot_id"`
		SlotID     int64 `db:"slot_id"`
	}

	manual, err := db.Many[manualInvitation](tx, "SELECT timeslot_id, slot_id FROM invitations WHERE session_id = ? AND group_id IS NULL", session.ID)
	if err != nil {
		return plan, "", err
	}

	plan.manual = len(manual)

	timetableGroups, err := timetableGroups(tx, timetableID)
	if err != nil {
		return plan, "", err
	}

	if len(timetableGroups) == 0 {
		return plan, "No groups assigned to this timetable", nil
	}

	groupName, groupColor := map[int64]string{}, map[int64]string{}
	for _, tg := range timetableGroups {
		groupName[tg.GroupID], groupColor[tg.GroupID] = tg.GroupName, tg.GroupColor
	}

	groups := scheduling.AllocateSlots(plan.totalSlots-len(manual), schedulingGroups(timetableGroups))
	plan.quotas = groups
	quotaLabel := map[int64]string{}
	for _, g := range groups {
		quotaLabel[g.ID] = fmt.Sprintf("%d slots (%d%%)", g.Slots, int64(g.Percentage))
	}

	type assignedInstructor struct {
		ID     int64 `db:"id"`
		SlotID int64 `db:"slot_id"`
	}

	instructors, err := db.Many[assignedInstructor](tx, `
		SELECT i.id, ss.id AS slot_id FROM instructors i
		JOIN session_slots ss ON ss.instructor_id = i.id
		WHERE ss.session_id = ? AND ss.removed = 0
		ORDER BY i.last_name ASC, i.first_name ASC`, session.ID)
	if err != nil {
		return plan, "", err
	}

	// Free instructor slots per timeslot, in instructor order. Every timeslot has one spot per
	// instructor; spots of manual invitations are taken.
	type spotKey struct{ timeslotID, slotID int64 }
	taken := map[spotKey]bool{}
	for _, mi := range manual {
		taken[spotKey{mi.TimeslotID, mi.SlotID}] = true
	}

	freeSlots := make([][]int64, len(timeslots))
	timeslotCapacity := make([]scheduling.Timeslot, len(timeslots))
	for ti, ts := range timeslots {
		for _, in := range instructors {
			if !taken[spotKey{ts.ID, in.SlotID}] {
				freeSlots[ti] = append(freeSlots[ti], in.SlotID)
			}
		}

		timeslotCapacity[ti] = scheduling.Timeslot{ID: ts.ID, Capacity: len(freeSlots[ti])}
	}

	prefs, err := loadTimeslotPrefs(tx, timetableID)
	if err != nil {
		return plan, "", err
	}

	buddies, err := loadBuddies(tx)
	if err != nil {
		return plan, "", err
	}

	// The auto-generated invitations go before the queue is read: as counted invitations they
	// would otherwise make everyone in the current schedule look like they just had a turn.
	if _, err := tx.Exec("DELETE FROM invitations WHERE session_id = ? AND group_id IS NOT NULL", session.ID); err != nil {
		return plan, "", err
	}

	eligible, err := eligibleQueue(tx, loc, session.ID, session.Date, timetableID)
	if err != nil {
		return plan, "", err
	}

	if len(eligible) == 0 && len(manual) == 0 {
		return plan, "No eligible students found. Ensure students have group memberships with access to disciplines.", nil
	}

	result := scheduling.Generate(scheduling.Input{
		Queue:     eligible,
		Groups:    groups,
		Timeslots: timeslotCapacity,
		Allows:    prefs.allows,
		Buddies:   buddies,
		Seed:      session.ID, // regenerating the same session yields the same overflow picks
	})

	plan.skipped = result.Skipped

	// Each placed student gets the first free instructor spot of their timeslot.
	for _, p := range result.Placements {
		st := p.Member
		slotID := freeSlots[p.Timeslot][0]
		freeSlots[p.Timeslot] = freeSlots[p.Timeslot][1:]

		var quota, buddyOf string
		if !p.Overflow {
			quota = quotaLabel[p.GroupID]
		}

		if p.PulledUpBy != nil {
			buddyOf = p.PulledUpBy.FirstName + " " + p.PulledUpBy.LastName
		}

		plan.invitations = append(plan.invitations, plannedInvitation{
			placement: p,
			timeslot:  timeslots[p.Timeslot],
			slotID:    slotID,
			log: batchLog{
				candidateLog: candidateLog{
					Trigger:              "batch_schedule",
					LastTurnAt:           st.LastTurnAt,
					InviteNext:           st.InviteNextPendingSince != nil,
					CandidateRank:        p.Rank,
					CandidatesConsidered: p.Considered,
					GroupName:            groupName[p.GroupID],
					GroupColor:           groupColor[p.GroupID],
					PreferredTimeslots:   prefs.startTimes(st.ID, timeslots),
					PreferredDays:        preferredDays(st.PreferredDays, clubDays),
					BuddyPlacedNear:      buddyOf,
				},
				GroupQuota: quota,
				Overflow:   p.Overflow,
			},
		})
	}

	return plan, "", nil
}

// unschedulable returns why no schedule can be planned for session (a message for a 400), or
// "" if one can.
func unschedulable(session Session) string {
	if session.Status != "draft" && session.Status != "scheduled" {
		return "A schedule can only be generated before invitations are sent"
	}

	if session.TimetableID == nil {
		return "No timetable attached to this session"
	}

	return ""
}

func (s *Server) handleGenerateSchedule(w http.ResponseWriter, r *http.Request) error {
	sessionID, ok := pathID(r, "id")
	if !ok {
		httpx.Error(w, http.StatusNotFound, "Training session not found")
		return nil
	}

	session, found, err := getSession(s.db, sessionID)
	if err != nil {
		return err
	}
	if !found {
		httpx.Error(w, http.StatusNotFound, "Training session not found")
		return nil
	}

	if problem := unschedulable(session); problem != "" {
		httpx.Error(w, http.StatusBadRequest, problem)
		return nil
	}

	clubDays := clubDays(s.db)
	loc := clubLocation(s.db)

	// From here on everything runs in one transaction, so a failed regeneration leaves the
	// current schedule in place. No queries on s.db until it is committed (see db.Open).
	tx, err := s.db.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after Commit

	plan, problem, err := planSchedule(tx, session, loc, clubDays)
	if err != nil {
		return err
	}
	if problem != "" {
		httpx.Error(w, http.StatusBadRequest, problem)
		return nil
	}

	invited := []ScheduledInvitation{}
	for _, pi := range plan.invitations {
		st := pi.placement.Member
		token := uuid.NewString()
		if _, err := tx.Exec(`
			INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token, group_id, decision_log)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, sessionID, st.ID, pi.timeslot.ID, pi.slotID, token, pi.placement.GroupID, encodeJSON(pi.log)); err != nil {
			return err
		}
		invited = append(invited, ScheduledInvitation{
			StudentID: st.ID, FirstName: st.FirstName, LastName: st.LastName, Token: token,
			TimeslotID: pi.timeslot.ID, SlotID: pi.slotID, StartTime: pi.timeslot.StartTime, GroupID: pi.placement.GroupID,
		})
	}

	if _, err := tx.Exec("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?", sessionID); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	s.broadcastSessionReload(sessionID)
	s.broadcastSessionCounts(sessionID)

	httpx.OK(w, map[string]any{
		"session_id":       sessionID,
		"total_slots":      plan.totalSlots,
		"students_invited": len(invited) + plan.manual,
		"invitations":      invited,
	})
	return nil
}

func (s *Server) handleSchedulePreview(w http.ResponseWriter, r *http.Request) error {
	sessionID, ok := pathID(r, "id")
	if !ok {
		httpx.Error(w, http.StatusNotFound, "Training session not found")
		return nil
	}

	session, found, err := getSession(s.db, sessionID)
	if err != nil {
		return err
	}
	if !found {
		httpx.Error(w, http.StatusNotFound, "Training session not found")
		return nil
	}

	if problem := unschedulable(session); problem != "" {
		httpx.Error(w, http.StatusBadRequest, problem)
		return nil
	}

	clubDays := clubDays(s.db)
	loc := clubLocation(s.db)

	// planSchedule deletes the current auto-generated invitations; the preview only rolls back.
	tx, err := s.db.Beginx()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	plan, problem, err := planSchedule(tx, session, loc, clubDays)
	if err != nil {
		return err
	}
	if problem != "" {
		httpx.Error(w, http.StatusBadRequest, problem)
		return nil
	}

	// The queues as the plan saw them (same eligibility and tie breaking as eligibleQueue),
	// with what the plan does with each student.
	elig, err := loadEligibility(tx, loc, sessionID, session.Date, *session.TimetableID)
	if err != nil {
		return err
	}

	groups, timeslots, err := loadQueues(tx, elig, *session.TimetableID, sessionID)
	if err != nil {
		return err
	}

	invited := map[int64]plannedInvitation{}
	for _, pi := range plan.invitations {
		invited[pi.placement.Member.ID] = pi
	}

	skipped := map[int64]bool{}
	for _, m := range plan.skipped {
		skipped[m.ID] = true
	}

	slots := map[int64]int{}
	for _, q := range plan.quotas {
		slots[q.ID] = q.Slots
	}

	for i := range groups {
		g := &groups[i]
		n := slots[g.GroupID]
		g.Slots = &n
		for j := range g.Queue {
			e := &g.Queue[j]
			e.Schedule = &EntrySchedule{Skipped: skipped[e.ID]}
			if pi, ok := invited[e.ID]; ok {
				e.Schedule.Invited = true
				e.Schedule.StartTime = &pi.timeslot.StartTime
				e.Schedule.Overflow = pi.placement.Overflow
			}
		}
	}

	httpx.OK(w, map[string]any{
		"session_id":       sessionID,
		"total_slots":      plan.totalSlots,
		"students_invited": len(plan.invitations) + plan.manual,
		"timeslots":        timeslots,
		"groups":           groups,
	})
	return nil
}
