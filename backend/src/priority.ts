import db from './database.js';

// Normalize priorities per group so that, within each group, the lowest-priority
// active (non-cooldown, non-deleted) member has priority 1. Groups are normalized
// independently — priority values are only meaningful within a group.
export function normalizePriorities(): void {
  db.prepare(`
    UPDATE student_groups
    SET priority = priority - (
      SELECT MIN(sg2.priority) - 1
      FROM student_groups sg2
      JOIN students s2 ON s2.id = sg2.student_id
      WHERE sg2.group_id = student_groups.group_id
        AND s2.active = 1
        AND s2.deleted_at IS NULL
        AND (s2.cooldown_until IS NULL OR s2.cooldown_until <= datetime('now'))
    )
    WHERE group_id IN (
      SELECT sg3.group_id
      FROM student_groups sg3
      JOIN students s3 ON s3.id = sg3.student_id
      WHERE s3.active = 1
        AND s3.deleted_at IS NULL
        AND (s3.cooldown_until IS NULL OR s3.cooldown_until <= datetime('now'))
      GROUP BY sg3.group_id
      HAVING MIN(sg3.priority) <> 1
    )
  `).run();
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
