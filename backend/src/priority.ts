import db from './database.js';

// Normalize priorities per group so that, within each group, the lowest-priority
// active (non-cooldown, non-deleted) member has priority 1. Groups are normalized
// independently — priority values are only meaningful within a group.
export function normalizePriorities(): void {
  // Snapshot the per-group offset FIRST, then apply it. A single self-referencing
  // UPDATE (SET priority = priority - (SELECT MIN(priority) - 1 ...)) is unsafe here:
  // SQLite evaluates the correlated subquery against the partially-updated table, so
  // once the first row drops to 1 the group MIN becomes 1 and the remaining rows are
  // left unchanged. Computing the offsets up front makes the operation order-independent.
  const groups = db.prepare(`
    SELECT sg.group_id AS group_id, MIN(sg.priority) AS min_priority
    FROM student_groups sg
    JOIN students s ON s.id = sg.student_id
    WHERE s.active = 1
      AND s.deleted_at IS NULL
      AND (s.cooldown_until IS NULL OR s.cooldown_until <= datetime('now'))
    GROUP BY sg.group_id
    HAVING MIN(sg.priority) <> 1
  `).all() as Array<{ group_id: number; min_priority: number }>;

  const update = db.prepare('UPDATE student_groups SET priority = priority - ? WHERE group_id = ?');
  for (const g of groups) {
    update.run(g.min_priority - 1, g.group_id);
  }
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
