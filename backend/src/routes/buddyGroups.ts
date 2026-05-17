import { Router, Request, Response } from 'express';
import db from '../database.js';

const router = Router();

// Quick-create: create a buddy group from a list of student IDs
router.post('/quick-create', (req: Request, res: Response) => {
  const { student_ids } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length < 2) {
    res.status(400).json({ error: 'At least 2 students are required' }); return;
  }

  // Check none are already in a buddy group
  const alreadyAssigned = db.prepare(
    `SELECT s.first_name, s.last_name FROM buddy_group_members bgm JOIN students s ON s.id = bgm.student_id WHERE bgm.student_id IN (${student_ids.map(() => '?').join(',')})`
  ).all(...student_ids) as { first_name: string; last_name: string }[];
  if (alreadyAssigned.length > 0) {
    res.status(400).json({ error: `${alreadyAssigned[0].first_name} ${alreadyAssigned[0].last_name} is already in a buddy group` }); return;
  }

  const result = db.prepare('INSERT INTO buddy_groups DEFAULT VALUES').run();
  const groupId = result.lastInsertRowid;

  const insert = db.prepare('INSERT INTO buddy_group_members (buddy_group_id, student_id) VALUES (?, ?)');
  for (const sid of student_ids) {
    insert.run(groupId, sid);
  }

  res.status(201).json({ id: groupId });
});

// Delete buddy group
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM buddy_groups WHERE id = ?').run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Buddy group not found' }); return; }
  res.json({ success: true });
});

// Remove a member from a buddy group
router.delete('/:id/members/:studentId', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM buddy_groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Buddy group not found' }); return; }

  db.prepare('DELETE FROM buddy_group_members WHERE buddy_group_id = ? AND student_id = ?').run(req.params.id, req.params.studentId);

  // Delete group if no members remain
  const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM buddy_group_members WHERE buddy_group_id = ?').get(req.params.id) as { cnt: number };
  if (remaining.cnt === 0) {
    db.prepare('DELETE FROM buddy_groups WHERE id = ?').run(req.params.id);
  }

  res.json({ success: true });
});

export default router;
