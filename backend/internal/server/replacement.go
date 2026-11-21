package server

// Replacements: when an invitation is given up (declined, expired, cancelled), the spot goes
// to the next student in line.

import (
	mrand "math/rand/v2"

	"github.com/google/uuid"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/scheduling"
)

// vacatedSpot is an instructor x timeslot spot of a session that needs a new student.
type vacatedSpot struct {
	SessionID    int64
	SessionDate  string
	TimeslotID   int64
	SlotID       int64
	InvitationID int64  // the invitation that held the spot; 0 if none (seeds the random pick)
	GroupID      *int64 // group of the invitation that held the spot, if any
	StudentID    int64  // student who left the spot; 0 if unknown (only for the decision log)
	Status       string // why they left; "" if unknown (only for the decision log)
}

// random returns the random source for picking a replacement: seeded by the vacated
// invitation and the spot, so a pick can be reproduced.
func (v vacatedSpot) random() func() float64 {
	return mrand.New(mrand.NewPCG(uint64(v.InvitationID), uint64(v.SlotID)<<32|uint64(v.TimeslotID))).Float64
}

// findAndInviteReplacement invites the next student in line for a vacated spot. Reports
// whether anyone was eligible.
func (s *Server) findAndInviteReplacement(vacated vacatedSpot) (bool, error) {
	sessionID, sessionDate := vacated.SessionID, vacated.SessionDate

	// Without a timetable no group can be invited.
	session, found, err := s.getSession(sessionID)
	if err != nil || !found || session.TimetableID == nil {
		return false, err
	}
	timetableID := *session.TimetableID

	timetableGroups, err := s.timetableGroups(timetableID)
	if err != nil {
		return false, err
	}
	eligible, err := eligibleQueue(s.db, s.clubLocation(), sessionID, sessionDate, timetableID)
	if err != nil {
		return false, err
	}
	prefs, err := s.timeslotPrefs(timetableID)
	if err != nil {
		return false, err
	}
	buddies, err := s.loadBuddies()
	if err != nil {
		return false, err
	}
	// The vacated invitation already has its final status, so it doesn't count here.
	invitedIDs, err := db.Many[int64](s.db, "SELECT student_id FROM invitations WHERE session_id = ? AND status IN ('scheduled', 'invited', 'confirmed')", sessionID)
	if err != nil {
		return false, err
	}
	invited := map[int64]bool{}
	for _, id := range invitedIDs {
		invited[id] = true
	}
	var vacancyGroup int64
	if vacated.GroupID != nil {
		vacancyGroup = *vacated.GroupID
	}
	pick, found := scheduling.PickReplacement(scheduling.ReplacementInput{
		Queue:   eligible,
		Groups:  schedulingGroups(timetableGroups),
		Allows:  prefs.allows,
		Vacancy: scheduling.Vacancy{TimeslotID: vacated.TimeslotID, GroupID: vacancyGroup},
		Buddies: buddies,
		Invited: invited,
		Random:  vacated.random(),
	})
	if !found {
		return false, nil
	}
	replacement := pick.Member

	// Names for the decision log; a missing row (e.g. no vacated student) leaves them empty.
	replacedName, _, err := db.One[string](s.db, "SELECT first_name || ' ' || last_name FROM students WHERE id = ?", vacated.StudentID)
	if err != nil {
		return false, err
	}
	type groupLabel struct {
		Name  string `db:"name"`
		Color string `db:"color"`
	}
	group, _, err := db.One[groupLabel](s.db, "SELECT name, color FROM groups WHERE id = ?", pick.GroupID)
	if err != nil {
		return false, err
	}
	var buddyName string
	if pick.PulledUpBy != 0 {
		if buddyName, _, err = db.One[string](s.db, "SELECT first_name || ' ' || last_name FROM students WHERE id = ?", pick.PulledUpBy); err != nil {
			return false, err
		}
	}

	var preferredTimeslots []string
	if len(prefs[replacement.ID]) > 0 {
		slots, err := s.timetableTimeslots(timetableID)
		if err != nil {
			return false, err
		}
		preferredTimeslots = prefs.startTimes(replacement.ID, slots)
	}

	reason := "vacated"
	if vacated.Status != "" {
		reason = vacated.Status
	}
	// candidate_rank and candidates_considered count within the queue the replacement was
	// picked from (as in a generated schedule, where both are counted within the student's
	// group). The rank is 1 unless a buddy pulled them up.
	decisionLog := encodeJSON(replacementLog{
		candidateLog: candidateLog{
			Trigger:              "replacement",
			LastTurnAt:           replacement.LastTurnAt,
			InviteNext:           replacement.InviteNextPendingSince != nil,
			CandidateRank:        pick.Rank,
			CandidatesConsidered: pick.Considered,
			GroupName:            group.Name,
			GroupColor:           group.Color,
			PreferredTimeslots:   preferredTimeslots,
			PreferredDays:        preferredDays(replacement.PreferredDays, s.clubDays()),
			BuddyPlacedNear:      buddyName,
		},
		ReplacedStudent:   replacedName,
		ReplacementReason: reason,
		SameGroupMatch:    pick.SameGroup,
	})

	newID, err := db.Get[int64](s.db, "INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, group_id, token, decision_log) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
		sessionID, replacement.ID, vacated.TimeslotID, vacated.SlotID, pick.GroupID, uuid.NewString(), decisionLog)
	if err != nil {
		return false, err
	}

	if err := s.sendInvitation(newID); err != nil {
		return false, err
	}

	added, found, err := s.sessionInvitationByID(newID)
	if err != nil {
		return false, err
	}
	if found {
		s.hub.Broadcast(sessionChannel(sessionID), "invitation_added", added)
	}
	s.broadcastSessionCounts(sessionID)

	return true, nil
}
