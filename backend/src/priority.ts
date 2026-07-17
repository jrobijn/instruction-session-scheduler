import db from './database.js';

// Normalize priorities per group so that, within each group, the active
// (non-cooldown, non-deleted) members form a dense 1..n ranking with no gaps.
// Merely shifting the group minimum to 1 is not enough: when a member is removed,
// deleted or enters cooldown its priority value disappears from the active set and
// leaves a hole (e.g. 1, 3, 4). Renumbering with DENSE_RANK closes those holes while
// preserving both the existing order and any ties. Groups are normalized independently
// — priority values are only meaningful within a group.
export function normalizePriorities(): void {
  // Snapshot the target ranks FIRST, then apply them. A self-referencing UPDATE that
  // reads the group ordering while writing would evaluate its subquery against the
  // partially-updated table and corrupt the ranking. Materializing the DENSE_RANK
  // result into JS up front makes the writes order-independent.
  //
  // The population is restricted to active/non-cooldown/non-deleted members — the same
  // set used everywhere else for queue ordering. Cooled-down members keep their numeric
  // priority so they remain schedulable for post-cooldown sessions; excluding them here
  // freezes their value in place instead of letting them "save up" invitations.
  //
  // DENSE_RANK (not ROW_NUMBER) keeps existing ties collapsed onto the same number;
  // runtime tie-breaking is handled downstream by name ordering.
  const ranks = db.prepare(`
    SELECT sg.group_id AS group_id, sg.student_id AS student_id,
           DENSE_RANK() OVER (PARTITION BY sg.group_id ORDER BY sg.priority) AS new_priority
    FROM student_groups sg
    JOIN students s ON s.id = sg.student_id
    WHERE s.active = 1
      AND s.deleted_at IS NULL
      AND (s.cooldown_until IS NULL OR s.cooldown_until <= datetime('now'))
  `).all() as Array<{ group_id: number; student_id: number; new_priority: number }>;

  const update = db.prepare(`
    UPDATE student_groups SET priority = ?
    WHERE group_id = ? AND student_id = ? AND priority <> ?
  `);
  for (const r of ranks) {
    update.run(r.new_priority, r.group_id, r.student_id, r.new_priority);
  }
}

// Compute (and, for 'highest', apply the shift for) the priority a member should receive
// when joining or re-entering a group, according to the given policy mode. AVG/MAX/COUNT
// ignore NULLs, so un-ranked (inactive) members are naturally excluded. Returns the
// priority the joining member should be assigned; the caller performs the INSERT/UPDATE.
export function assignMemberPriority(groupId: number | string | string[], mode: string): number {
  if (mode === 'highest') {
    // New/returning member takes priority 1; push every ranked member back one level.
    db.prepare('UPDATE student_groups SET priority = priority + 1 WHERE group_id = ? AND priority IS NOT NULL').run(groupId);
    return 1;
  }
  if (mode === 'average') {
    // Takes the rounded average priority of existing ranked members.
    const stats = db.prepare('SELECT AVG(priority) AS avg, COUNT(priority) AS cnt FROM student_groups WHERE group_id = ?').get(groupId) as any;
    return stats && stats.cnt > 0 ? Math.round(stats.avg) : 1;
  }
  // 'lowest' (default): goes after all ranked members (MAX priority + 1).
  const maxPriority = (db.prepare('SELECT MAX(priority) AS m FROM student_groups WHERE group_id = ?').get(groupId) as any)?.m;
  return (maxPriority ?? 0) + 1;
}

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
