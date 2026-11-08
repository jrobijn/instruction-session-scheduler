// Package queue holds the invite queue SQL and the tie-breaking and weighted-pick
// helpers used when generating schedules.
package queue

import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	"sort"
	"strconv"
)

// countedStatuses are the invitation statuses that count as having had a turn.
const countedStatuses = "('scheduled','invited','confirmed')"

// JoinSQL is for queries aliasing students as `s` and student_groups as `sg`.
const JoinSQL = `
  LEFT JOIN groups qg ON qg.id = sg.group_id
  LEFT JOIN (
    SELECT i.student_id, MAX(datetime(ts.date)) AS last_turn_at
    FROM invitations i JOIN training_sessions ts ON ts.id = i.session_id
    WHERE i.status IN ` + countedStatuses + `
    GROUP BY i.student_id
  ) lt ON lt.student_id = s.id`

// ColumnsSQL selects last_turn_at, queue_at and invite_next_since.
//
// invite_next_since is set while an "invite next" override is pending (no counted invitation since).
// queue_at is the latest of the last turn and each event time whose group policy is 'back'
// (join, reactivation, cooldown end). Policies apply at query time. An empty string sorts first (front of the queue).
const ColumnsSQL = `
  lt.last_turn_at AS last_turn_at,
  MAX(
    COALESCE(lt.last_turn_at, ''),
    CASE WHEN qg.new_member_priority = 'back' THEN COALESCE(sg.joined_at, '') ELSE '' END,
    CASE WHEN qg.reactivated_member_priority = 'back' THEN COALESCE(sg.reactivated_at, '') ELSE '' END,
    CASE WHEN qg.cooldown_member_priority = 'back' THEN COALESCE(s.cooldown_until, '') ELSE '' END
  ) AS queue_at,
  CASE WHEN sg.invite_next_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invitations i2
    WHERE i2.student_id = s.id AND i2.status IN ` + countedStatuses + ` AND i2.invited_at >= sg.invite_next_at
  ) THEN sg.invite_next_at END AS invite_next_since`

const OrderSQL = "invite_next_since IS NULL, invite_next_since ASC, queue_at ASC"

// Columns holds the values selected by ColumnsSQL; embed it in a row struct. Only
// last_turn_at is part of API responses.
type Columns struct {
	LastTurnAt      *string `db:"last_turn_at" json:"last_turn_at"`
	QueueAt         string  `db:"queue_at" json:"-"`
	InviteNextSince *string `db:"invite_next_since" json:"-"`
}

// QueueTieKey implements part of Entry.
func (c Columns) QueueTieKey() string { return TieKey(c.InviteNextSince, c.QueueAt) }

// Entry is the part of a queue row that tie-breaking looks at.
type Entry interface {
	QueueID() int64
	QueueTieKey() string // invite_next_since + "|" + queue_at
}

// TieKey builds the tie key from nullable invite_next_since and queue_at values.
func TieKey(inviteNextSince *string, queueAt string) string {
	s := ""
	if inviteNextSince != nil {
		s = *inviteNextSince
	}
	return s + "|" + queueAt
}

// BreakTies reorders runs of equal queue position (rows must already be sorted by OrderSQL).
// The order is stable per (seed, student) but shuffled differently for each seed.
func BreakTies[T Entry](rows []T, seed int64) []T {
	hash := func(r T) uint32 {
		sum := sha256.Sum256([]byte(strconv.FormatInt(seed, 10) + ":" + strconv.FormatInt(r.QueueID(), 10)))
		return binary.BigEndian.Uint32(sum[:4])
	}
	out := make([]T, 0, len(rows))
	for start := 0; start < len(rows); {
		end := start + 1
		for end < len(rows) && rows[end].QueueTieKey() == rows[start].QueueTieKey() {
			end++
		}
		run := append([]T(nil), rows[start:end]...)
		hashes := make(map[int64]uint32, len(run))
		for _, r := range run {
			hashes[r.QueueID()] = hash(r)
		}
		sort.SliceStable(run, func(i, j int) bool {
			hi, hj := hashes[run[i].QueueID()], hashes[run[j].QueueID()]
			if hi != hj {
				return hi < hj
			}
			return run[i].QueueID() < run[j].QueueID()
		})
		out = append(out, run...)
		start = end
	}
	return out
}

// WeightedPickGroup picks a group id weighted by weightByGroup. When all weights are
// zero or missing, the pick is uniform.
func WeightedPickGroup(groupIDs []int64, weightByGroup map[int64]float64, random func() float64) int64 {
	weights := make([]float64, len(groupIDs))
	total := 0.0
	for i, g := range groupIDs {
		weights[i] = math.Max(0, weightByGroup[g])
		total += weights[i]
	}
	if total <= 0 {
		return groupIDs[int(math.Floor(random()*float64(len(groupIDs))))]
	}
	r := random() * total
	for i, g := range groupIDs {
		r -= weights[i]
		if r < 0 {
			return g
		}
	}
	return groupIDs[len(groupIDs)-1]
}
