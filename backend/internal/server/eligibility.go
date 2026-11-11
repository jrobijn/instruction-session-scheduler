package server

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// sessionEligibility decides who can be invited to a session; see allows.
type sessionEligibility struct {
	date      string         // the session date, in the club's timezone
	loc       *time.Location // the club's timezone
	dayOfWeek string         // "" if the date is invalid: then nobody is eligible
	groups    map[int64]bool // the timetable's groups that have an active discipline
	invited   map[int64]bool // students with an invitation to this session, in any status
}

// allows reports whether m can be invited: they are active, in one of the timetable's groups
// that has an active discipline, prefer the session's weekday, have no cooldown running past
// the session date, and have no invitation to this session yet.
func (e *sessionEligibility) allows(m queue.Member) bool {
	// cooldown_until is always stored as "YYYY-MM-DD HH:MM:SS" (UTC). A cooldown ending
	// during the session day, in the club's timezone, is over by then; an unreadable value
	// keeps it running.
	cooldownOver := true
	if m.CooldownUntil != nil {
		end, err := time.Parse(time.DateTime, *m.CooldownUntil)
		cooldownOver = err == nil && end.In(e.loc).Format(time.DateOnly) <= e.date
	}
	return m.Active != 0 &&
		e.groups[m.GroupID] &&
		!e.invited[m.ID] &&
		e.dayOfWeek != "" && slices.Contains(strings.Split(m.PreferredDays, "|"), e.dayOfWeek) &&
		cooldownOver
}

func loadEligibility(q db.Querier, loc *time.Location, sessionID int64, date string, timetableID int64) (*sessionEligibility, error) {
	e := &sessionEligibility{date: date, loc: loc, groups: map[int64]bool{}, invited: map[int64]bool{}}
	if d, ok := dayOfWeek(date); ok {
		e.dayOfWeek = strconv.Itoa(d)
	}

	groupIDs, err := db.Many[int64](q, `
		SELECT tg.group_id FROM timetable_groups tg
		WHERE tg.timetable_id = ? AND EXISTS (
			SELECT 1 FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id
			WHERE dg.group_id = tg.group_id AND d.active = 1
		)`, timetableID)
	if err != nil {
		return nil, err
	}
	for _, id := range groupIDs {
		e.groups[id] = true
	}

	// Any status counts: someone who declined or let an invitation expire is not invited again
	// automatically (an admin still can). There is at most one session per date (unique
	// training_sessions.date), so this also covers being booked elsewhere that day.
	studentIDs, err := db.Many[int64](q, "SELECT DISTINCT student_id FROM invitations WHERE session_id = ?", sessionID)
	if err != nil {
		return nil, err
	}
	for _, id := range studentIDs {
		e.invited[id] = true
	}
	return e, nil
}

// eligibleQueue loads the students who can be invited to a session (see
// sessionEligibility.allows), in queue order with ties broken by the session id. loc is the
// club's timezone (see Server.clubLocation; look it up before starting a transaction).
func eligibleQueue(q db.Querier, loc *time.Location, sessionID int64, date string, timetableID int64) ([]queue.Member, error) {
	e, err := loadEligibility(q, loc, sessionID, date, timetableID)
	if err != nil {
		return nil, err
	}
	members, err := queue.LoadMembers(q)
	if err != nil {
		return nil, err
	}
	eligible := slices.DeleteFunc(members, func(m queue.Member) bool { return !e.allows(m) })
	queue.Sort(eligible, sessionID)
	return eligible, nil
}
