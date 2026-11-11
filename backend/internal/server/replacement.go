package server

// Replacements: when an invitation is given up (declined, expired, cancelled), the spot goes
// to the next student in line.

import (
	mrand "math/rand/v2"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/email"
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

// Replacement is the student invited for a vacated spot.
type Replacement struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// findAndInviteReplacement invites the next student in line for a vacated spot. Returns nil
// when nobody is eligible.
func (s *Server) findAndInviteReplacement(vacated vacatedSpot) (*Replacement, error) {
	sessionID, sessionDate := vacated.SessionID, vacated.SessionDate

	// Without a timetable no group can be invited.
	var timetableID int64
	s.db.QueryRow("SELECT COALESCE(timetable_id, 0) FROM training_sessions WHERE id = ?", sessionID).Scan(&timetableID)
	if timetableID == 0 {
		return nil, nil
	}

	timetableGroups, err := s.timetableGroups(timetableID)
	if err != nil {
		return nil, err
	}
	eligible, err := eligibleQueue(s.db, s.clubLocation(), sessionID, sessionDate, timetableID)
	if err != nil {
		return nil, err
	}
	prefs, err := s.timeslotPrefs(timetableID)
	if err != nil {
		return nil, err
	}
	buddies, err := s.loadBuddies()
	if err != nil {
		return nil, err
	}
	// The vacated invitation already has its final status, so it doesn't count here.
	invitedIDs, err := db.Many[int64](s.db, "SELECT student_id FROM invitations WHERE session_id = ? AND status IN ('scheduled', 'invited', 'confirmed')", sessionID)
	if err != nil {
		return nil, err
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
		return nil, nil
	}
	replacement := pick.Member

	var replacedName, groupName, groupColor, buddyName string
	s.db.QueryRow("SELECT first_name || ' ' || last_name FROM students WHERE id = ?", vacated.StudentID).Scan(&replacedName)
	s.db.QueryRow("SELECT name, color FROM groups WHERE id = ?", pick.GroupID).Scan(&groupName, &groupColor)
	if pick.PulledUpBy != 0 {
		s.db.QueryRow("SELECT first_name || ' ' || last_name FROM students WHERE id = ?", pick.PulledUpBy).Scan(&buddyName)
	}

	var preferredTimeslots []string
	if len(prefs[replacement.ID]) > 0 {
		slots, err := s.timetableTimeslots(timetableID)
		if err != nil {
			return nil, err
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
			CandidateRank:        pick.Rank,
			CandidatesConsidered: pick.Considered,
			GroupName:            nonEmpty(groupName),
			GroupColor:           nonEmpty(groupColor),
			BuddyPlacedNear:      nonEmpty(buddyName),
		}.withStudent(replacement, preferredTimeslots, db.Setting(s.db, "club_days", "0|1|2|3|4|5|6")),
		ReplacedStudent:   nonEmpty(replacedName),
		ReplacementReason: reason,
		SameGroupMatch:    pick.SameGroup,
	})

	token := newToken()
	if _, err := s.db.Exec("INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, group_id, token, decision_log) VALUES (?, ?, ?, ?, ?, ?, ?)",
		sessionID, replacement.ID, vacated.TimeslotID, vacated.SlotID, pick.GroupID, token, decisionLog); err != nil {
		return nil, err
	}

	name := replacement.FirstName + " " + replacement.LastName
	s.mailer.SendInvitation(email.InvitationParams{
		To: replacement.Email, StudentName: name, Date: sessionDate, Token: token,
		ClubName: s.clubName(), Locale: s.emailLocale(),
	})
	if _, err := s.db.Exec("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE token = ?", token); err == nil {
		var newID int64
		if s.db.QueryRow("SELECT id FROM invitations WHERE token = ?", token).Scan(&newID) == nil {
			s.scheduleExpiryForInvitation(newID)
		}
	}

	added, err := s.sessionInvitations(sessionDate, "WHERE inv.token = ?", token)
	if err != nil {
		return nil, err
	}
	if len(added) > 0 {
		s.hub.BroadcastSession(sessionID, "invitation_added", added[0])
	}
	s.broadcastSessionCounts(sessionID)

	return &Replacement{Name: name, Email: replacement.Email}, nil
}
