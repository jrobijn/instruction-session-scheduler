package server

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// Queues per timetable group: who can be invited on a date, in the order the scheduler takes
// them, and who can't and why. GET /api/timetables/:id/queues shows them as they stand today,
// for a weekday or any; the session's schedule preview (schedule.go) adds what generating would
// do.

// QueueGroup is a timetable group's queue for a date.
type QueueGroup struct {
	GroupID    int64  `json:"group_id"`
	GroupName  string `json:"group_name"`
	GroupColor string `json:"group_color"`
	Percentage int64  `json:"percentage"`
	Slots      *int   `json:"slots"` // the group's quota of a session's spots; only in a schedule preview

	// Queue are the members who can be invited, in queue order; Unavailable the others, in the
	// order the queue would have had them.
	Queue       []QueueEntry `json:"queue"`
	Unavailable []QueueEntry `json:"unavailable"`
}

// QueueEntry is a student in a group's queue.
type QueueEntry struct {
	ID            int64          `json:"id"`
	FirstName     string         `json:"first_name"`
	LastName      string         `json:"last_name"`
	Position      *int           `json:"queue_position"` // 1-based in the group's queue; nil if unavailable
	LastTurnAt    *string        `json:"last_turn_at"`
	CooldownUntil *string        `json:"cooldown_until"` // as stored
	InviteNext    bool           `json:"invite_next"`
	QueueOverride *QueueOverride `json:"queue_override"`
	BuddyGroupID  *int64         `json:"buddy_group_id"`
	Buddies       []QueueBuddy   `json:"buddies"` // the other members of their buddy group

	// PreferredTimeslots are the start times of the timetable's timeslots the student prefers;
	// null if they have no preference.
	PreferredTimeslots []string `json:"preferred_timeslots"`

	// Unavailable says why an unavailable student can't be invited: an exclusion of
	// sessionEligibility. Empty for students in the queue.
	Unavailable string `json:"unavailable"`

	// Schedule is what generating the schedule would do with the student; only in a schedule
	// preview.
	Schedule *EntrySchedule `json:"schedule"`
}

// EntrySchedule is what generating a session's schedule would do with a student.
type EntrySchedule struct {
	// Invited is set when the student would be invited, at StartTime; Overflow when that is
	// with a spot left over beyond the group quotas.
	Invited   bool    `json:"invited"`
	StartTime *string `json:"start_time"`
	Overflow  bool    `json:"overflow"`

	// Skipped is set when the student was up for a spot but none of the timeslots they allow
	// had room.
	Skipped bool `json:"skipped"`
}

// QueueOverride says which event placed a member at the back of the queue.
type QueueOverride struct {
	Reason string `json:"reason"` // joined, reactivated or cooldown
	At     string `json:"at"`
}

// QueueBuddy is a buddy of a student in a queue.
type QueueBuddy struct {
	Buddy

	// Apart says why the buddy can't be invited together with the student: otherGroup, noGroup,
	// or an exclusion of sessionEligibility (inactive, invited, otherDay, cooldown). Empty if
	// they can.
	Apart string `json:"apart"`
}

// loadQueues lists the queue of each of the timetable's groups, in their configured order, as
// elig sees who can be invited. Ties are broken with seed, as queue.Sort does for the
// scheduler (the session id). It also returns the timetable's timeslots.
func loadQueues(q db.Querier, elig *sessionEligibility, timetableID, seed int64) ([]QueueGroup, []Timeslot, error) {
	groups, err := timetableGroups(q, timetableID)
	if err != nil {
		return nil, nil, err
	}

	timeslots, err := timetableTimeslots(q, timetableID)
	if err != nil {
		return nil, nil, err
	}

	prefs, err := loadTimeslotPrefs(q, timetableID)
	if err != nil {
		return nil, nil, err
	}

	everyone, err := queue.LoadMembers(q)
	if err != nil {
		return nil, nil, err
	}

	buddyGroups, err := buddyGroupMembers(q)
	if err != nil {
		return nil, nil, err
	}

	memberByID := map[int64]queue.Member{}
	for _, m := range everyone {
		memberByID[m.ID] = m
	}

	buddyGroupOf := map[int64]int64{}
	for id, members := range buddyGroups {
		for _, b := range members {
			buddyGroupOf[b.ID] = id
		}
	}

	queue.Sort(everyone, seed)

	out := make([]QueueGroup, len(groups))
	for i, g := range groups {
		out[i] = QueueGroup{
			GroupID: g.GroupID, GroupName: g.GroupName, GroupColor: g.GroupColor, Percentage: g.Percentage,
			Queue: []QueueEntry{}, Unavailable: []QueueEntry{},
		}
		for _, m := range everyone {
			if m.GroupID != g.GroupID {
				continue
			}

			e := QueueEntry{
				ID: m.ID, FirstName: m.FirstName, LastName: m.LastName,
				LastTurnAt:         m.LastTurnAt,
				CooldownUntil:      m.CooldownUntil,
				InviteNext:         m.InviteNextPendingSince != nil,
				PreferredTimeslots: prefs.startTimes(m.ID, timeslots),
				Unavailable:        elig.exclusion(m),
			}
			if m.QueueReason != nil {
				e.QueueOverride = &QueueOverride{Reason: *m.QueueReason, At: m.QueueAt}
			}

			if e.Unavailable != "" {
				out[i].Unavailable = append(out[i].Unavailable, e)
				continue
			}

			position := len(out[i].Queue) + 1
			e.Position = &position
			if bg, ok := buddyGroupOf[m.ID]; ok {
				e.BuddyGroupID = &bg
				for _, b := range buddyGroups[bg] {
					if b.ID == m.ID {
						continue
					}

					// Buddies are only taken along from their own group's queue.
					var apart string
					if bm, inQueue := memberByID[b.ID]; !inQueue {
						apart = "noGroup"
					} else if bm.GroupID != m.GroupID {
						apart = "otherGroup"
					} else {
						apart = elig.exclusion(bm)
					}

					e.Buddies = append(e.Buddies, QueueBuddy{Buddy: b, Apart: apart})
				}
			}

			out[i].Queue = append(out[i].Queue, e)
		}
	}

	return out, timeslots, nil
}

// queueSeed is the seed that breaks ties in queues shown outside a session: the id of the next
// session still to be sent, so they show that session's order; 0 without one.
func (s *Server) queueSeed(q db.Querier) (int64, error) {
	seed, _, err := db.One[int64](q, `
		SELECT id FROM training_sessions
		WHERE status IN ('draft', 'scheduled') AND date >= ?
		ORDER BY date LIMIT 1`, s.now().In(clubLocation(q)).Format(time.DateOnly))
	return seed, err
}

func (s *Server) queueRoutes() {
	// The queues of a timetable's groups as they stand today, for one weekday (?day=0..6, Sunday
	// 0) or, without day, for any.
	s.adminRoute("GET /api/timetables/{id}/queues", func(w http.ResponseWriter, r *http.Request) error {
		timetableID, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}

		dayParam := r.URL.Query().Get("day")
		day, err := strconv.Atoi(dayParam)
		if dayParam != "" && (err != nil || day < 0 || day > 6) {
			httpx.Error(w, http.StatusBadRequest, "day must be a weekday number from 0 (Sunday) to 6")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM timetables WHERE id = ?", timetableID)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Timetable not found")
			return nil
		}

		seed, err := s.queueSeed(s.db)
		if err != nil {
			return err
		}

		// The queue as it stands today, not for a session: no invitations count (no session has
		// id 0), and cooldowns are judged against today.
		loc := clubLocation(s.db)
		elig, err := loadEligibility(s.db, loc, 0, s.now().In(loc).Format(time.DateOnly), timetableID)
		if err != nil {
			return err
		}

		elig.anyDay = dayParam == ""
		elig.dayOfWeek = strconv.Itoa(day)

		groups, timeslots, err := loadQueues(s.db, elig, timetableID, seed)
		if err != nil {
			return err
		}

		httpx.OK(w, map[string]any{
			"timeslots": timeslots,
			"groups":    groups,
		})
		return nil
	})
}
