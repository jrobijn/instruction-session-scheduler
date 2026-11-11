package server

import (
	"strconv"
	"strings"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// Decision logs: the JSON stored with each generated invitation (invitations.decision_log)
// that explains why that student was invited. Store them with encodeJSON.

// candidateLog is what every decision log records: who was invited and how they were
// chosen. batchLog and replacementLog embed it and add what is specific to them.
type candidateLog struct {
	Trigger              string   `json:"trigger"`
	LastTurnAt           *string  `json:"last_turn_at"`
	InviteNext           bool     `json:"invite_next"`
	CandidateRank        int      `json:"candidate_rank"`
	CandidatesConsidered int      `json:"candidates_considered"`
	GroupName            *string  `json:"group_name"`
	GroupColor           *string  `json:"group_color"`
	PreferredTimeslots   []string `json:"preferred_timeslots"`
	PreferredDays        []int    `json:"preferred_days"`
	// BuddyPlacedNear is the name of the buddy who pulled the student up, if any.
	BuddyPlacedNear *string `json:"buddy_placed_near"`
}

// withStudent returns l with the fields that describe the invited student m filled in.
// preferredTimeslots is from timeslotPrefs.startTimes; clubDays is the club_days setting.
func (l candidateLog) withStudent(m queue.Member, preferredTimeslots []string, clubDays string) candidateLog {
	l.LastTurnAt = m.LastTurnAt
	l.InviteNext = m.InviteNextPendingSince != nil
	l.PreferredTimeslots = preferredTimeslots
	l.PreferredDays = preferredDays(m.PreferredDays, clubDays)
	return l
}

// batchLog is the decision log of an invitation made by generating a schedule.
type batchLog struct {
	candidateLog
	GroupQuota *string `json:"group_quota"`
	Overflow   bool    `json:"overflow"`
}

// replacementLog is the decision log of an invitation for a vacated spot.
type replacementLog struct {
	candidateLog
	ReplacedStudent   *string `json:"replaced_student"`
	ReplacementReason string  `json:"replacement_reason"`
	SameGroupMatch    bool    `json:"same_group_match"`
}

// preferredDays lists the student's preferred days that are club days, for the decision log.
// It is nil (null in the log) when they cover every club day. Entries that are not day
// numbers are ignored.
func preferredDays(studentDays, clubDays string) []int {
	if studentDays == "" {
		return nil
	}
	club := map[int]bool{}
	for _, d := range strings.Split(clubDays, "|") {
		if n, err := strconv.Atoi(strings.TrimSpace(d)); err == nil {
			club[n] = true
		}
	}
	out := []int{}
	for _, d := range strings.Split(studentDays, "|") {
		if n, err := strconv.Atoi(strings.TrimSpace(d)); err == nil && club[n] {
			out = append(out, n)
		}
	}
	if len(out) >= len(club) {
		return nil
	}
	return out
}
