// Package queue defines the invite queue: the order in which students get a turn.
//
// LoadMembers loads every student in the queue with what all queue users need: who they are,
// what eligibility looks at, their group and their standing (queue state and position). The
// standing is computed in SQL (queue.sql); only breaking ties between equal positions is done
// in Go (Sort), with a seeded hash SQLite can't compute.
package queue

import (
	"cmp"
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"math"
	"slices"
	"strconv"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
)

//go:embed queue.sql
var membersQuery string

// Member is a student in the queue: a row of queue.sql. The JSON tags are those of API
// responses that embed it.
type Member struct {
	ID            int64   `db:"id" json:"id"`
	FirstName     string  `db:"first_name" json:"first_name"`
	LastName      string  `db:"last_name" json:"last_name"`
	Email         string  `db:"email" json:"email"`
	Active        int64   `db:"active" json:"active"`
	PreferredDays string  `db:"preferred_days" json:"preferred_days"`
	CooldownUntil *string `db:"cooldown_until" json:"cooldown_until"` // as stored
	GroupID       int64   `db:"group_id" json:"-"`

	// Queue standing; see queue.sql for each column.
	LastTurnAt             *string `db:"last_turn_at" json:"last_turn_at"`
	QueueAt                string  `db:"queue_at" json:"-"`
	QueueReason            *string `db:"queue_reason" json:"-"`
	InviteNextPendingSince *string `db:"invite_next_pending_since" json:"-"`
	QueuePosition          int64   `db:"queue_position" json:"-"`
}

// LoadMembers returns every student in the queue (non-deleted and in a group), in no
// particular order. It is the only way to load queue data, so every caller gets every column.
// A column of queue.sql without a field in Member fails the scan.
func LoadMembers(q db.Querier) ([]Member, error) {
	return db.Many[Member](q, membersQuery)
}

// Sort puts members in queue order (by queue_position). Ties are shuffled by seed: the order
// is stable per (seed, student) but different for each seed.
func Sort(members []Member, seed int64) {
	hashes := make(map[int64]uint32, len(members))
	for _, m := range members {
		hashes[m.ID] = tieHash(seed, m.ID)
	}
	slices.SortFunc(members, func(a, b Member) int {
		return cmp.Or(
			cmp.Compare(a.QueuePosition, b.QueuePosition),
			cmp.Compare(hashes[a.ID], hashes[b.ID]),
			cmp.Compare(a.ID, b.ID),
		)
	})
}

func tieHash(seed, id int64) uint32 {
	sum := sha256.Sum256([]byte(strconv.FormatInt(seed, 10) + ":" + strconv.FormatInt(id, 10)))
	return binary.BigEndian.Uint32(sum[:4])
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
