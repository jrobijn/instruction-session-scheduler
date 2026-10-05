import db from './database.js';

// Invite queue: within a group, students are invited in order of who has waited longest.
// The order is derived from invitation history, so declines/cancellations/regeneration need
// no bookkeeping — only invitations with these statuses count as having had a turn.
const COUNTED_STATUSES = "('scheduled','invited','confirmed')";

// SQL fragments for queries aliasing students as `s` and student_groups as `sg`.
export const QUEUE_JOIN_SQL = `
  LEFT JOIN groups qg ON qg.id = sg.group_id
  LEFT JOIN (
    SELECT i.student_id, MAX(datetime(ts.date)) AS last_turn_at
    FROM invitations i JOIN training_sessions ts ON ts.id = i.session_id
    WHERE i.status IN ${COUNTED_STATUSES}
    GROUP BY i.student_id
  ) lt ON lt.student_id = s.id`;

// invite_next_since is set while an "invite next" override is pending (no counted invitation since).
// queue_at is the latest of the last turn and each event time whose group policy is 'back'
// (join, reactivation, cooldown end). Policies apply at query time. '' = front.
export const QUEUE_COLUMNS_SQL = `
  lt.last_turn_at AS last_turn_at,
  MAX(
    COALESCE(lt.last_turn_at, ''),
    CASE WHEN qg.new_member_priority = 'back' THEN COALESCE(sg.joined_at, '') ELSE '' END,
    CASE WHEN qg.reactivated_member_priority = 'back' THEN COALESCE(sg.reactivated_at, '') ELSE '' END,
    CASE WHEN qg.cooldown_member_priority = 'back' THEN COALESCE(s.cooldown_until, '') ELSE '' END
  ) AS queue_at,
  CASE WHEN sg.invite_next_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invitations i2
    WHERE i2.student_id = s.id AND i2.status IN ${COUNTED_STATUSES} AND i2.invited_at >= sg.invite_next_at
  ) THEN sg.invite_next_at END AS invite_next_since`;

export const QUEUE_ORDER_SQL = 'invite_next_since IS NULL, invite_next_since ASC, queue_at ASC';

// Pick a group from the given list, weighted by each group's weight (e.g. timetable
// percentage). Groups with no/zero weight fall back to uniform selection. Weights are
// implicitly renormalized over the provided groups.
export function weightedPickGroup(groupIds: number[], weightByGroup: Map<number, number>): number {
  const weights = groupIds.map(g => Math.max(0, weightByGroup.get(g) ?? 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return groupIds[Math.floor(Math.random() * groupIds.length)];
  }
  let r = Math.random() * total;
  for (let i = 0; i < groupIds.length; i++) {
    r -= weights[i];
    if (r < 0) return groupIds[i];
  }
  return groupIds[groupIds.length - 1];
}
