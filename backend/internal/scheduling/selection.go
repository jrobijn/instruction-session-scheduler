package scheduling

import (
	"slices"

	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
)

// selection is a student taken within their group's quota.
type selection struct {
	member     queue.Member
	pulledUpBy *queue.Member // the buddy whose selection pulled them up, if any
}

// selectWithBuddies takes the first slots students of a group's queue (list). Right after
// each student it takes that student's buddies in the same queue, ahead of their turn, while
// slots last. Students taken as buddies don't pull up buddies of their own. rest is the rest
// of the queue, in order.
func selectWithBuddies(list []queue.Member, slots int, buddies Buddies) (selected []selection, rest []queue.Member) {
	taken := map[int64]bool{}
	take := func(st queue.Member, pulledUpBy *queue.Member) {
		taken[st.ID] = true
		selected = append(selected, selection{member: st, pulledUpBy: pulledUpBy})
	}
	for i, st := range list {
		if len(taken) >= slots {
			break
		}
		if taken[st.ID] {
			continue
		}
		take(st, nil)
		for _, buddy := range list {
			if len(taken) >= slots {
				break
			}
			if !taken[buddy.ID] && slices.Contains(buddies[st.ID], buddy.ID) {
				take(buddy, &list[i])
			}
		}
	}
	rest = []queue.Member{}
	for _, st := range list {
		if !taken[st.ID] {
			rest = append(rest, st)
		}
	}
	return selected, rest
}
