import crypto from 'crypto';
import db from './database.js';

// Reorders runs of equal queue position (rows must already be sorted by QUEUE_ORDER_SQL).
// Stable per (seed, student) but shuffled differently for each seed (e.g. session id).
export function breakQueueTies<T extends { id: number; invite_next_since: string | null; queue_at: string }>(rows: T[], seed: number): T[] {
  const tieKey = (r: T) => `${r.invite_next_since ?? ''}|${r.queue_at}`;
  const hash = (r: T) => crypto.createHash('sha256').update(`${seed}:${r.id}`).digest().readUInt32BE(0);
  const result: T[] = [];
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (end < rows.length && tieKey(rows[end]) === tieKey(rows[start])) end++;
    result.push(...rows.slice(start, end)
      .map(r => ({ r, h: hash(r) }))
      .sort((a, b) => a.h - b.h || a.r.id - b.r.id)
      .map(x => x.r));
    start = end;
  }
  return result;
}

// Seeded PRNG (mulberry32) so random choices are reproducible.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
export function weightedPickGroup(groupIds: number[], weightByGroup: Map<number, number>, random: () => number = Math.random): number {
  const weights = groupIds.map(g => Math.max(0, weightByGroup.get(g) ?? 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return groupIds[Math.floor(random() * groupIds.length)];
  }
  let r = random() * total;
  for (let i = 0; i < groupIds.length; i++) {
    r -= weights[i];
    if (r < 0) return groupIds[i];
  }
  return groupIds[groupIds.length - 1];
}
