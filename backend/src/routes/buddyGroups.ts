import { Router, Request, Response } from 'express';
import db from '../database.js';

const router = Router();

// List all buddy groups with member counts
router.get('/', (_req: Request, res: Response) => {
  const groups = db.prepare(`
    SELECT bg.*,
      (SELECT COUNT(*) FROM buddy_group_members WHERE buddy_group_id = bg.id) AS member_count
    FROM buddy_groups bg
    ORDER BY bg.name ASC
  `).all();
  res.json(groups);
});

// Create buddy group
router.post('/', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) { res.status(400).json({ error: 'Name is required' }); return; }

  const result = db.prepare('INSERT INTO buddy_groups (name) VALUES (?)').run(String(name).trim());
  const group = db.prepare('SELECT * FROM buddy_groups WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(group);
});

// Update buddy group
router.put('/:id', (req: Request, res: Response) => {
  const { name } = req.body;
  const group = db.prepare('SELECT * FROM buddy_groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Buddy group not found' }); return; }

  if (name !== undefined) {
    if (!String(name).trim()) { res.status(400).json({ error: 'Name is required' }); return; }
    db.prepare('UPDATE buddy_groups SET name = ? WHERE id = ?').run(String(name).trim(), req.params.id);
  }

  const updated = db.prepare('SELECT * FROM buddy_groups WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete buddy group
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM buddy_groups WHERE id = ?').run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Buddy group not found' }); return; }
  res.json({ success: true });
});

// Get members of a buddy group
router.get('/:id/members', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM buddy_groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Buddy group not found' }); return; }

  const members = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.email, s.active
    FROM students s
    JOIN buddy_group_members bgm ON bgm.student_id = s.id
    WHERE bgm.buddy_group_id = ?
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all(req.params.id);
  res.json(members);
});

// Add a member to a buddy group
router.post('/:id/members', (req: Request, res: Response) => {
  const { student_id } = req.body;
  if (!student_id) { res.status(400).json({ error: 'student_id is required' }); return; }

  const group = db.prepare('SELECT * FROM buddy_groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Buddy group not found' }); return; }

  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(student_id) as any;
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const existing = db.prepare('SELECT buddy_group_id FROM buddy_group_members WHERE student_id = ?').get(student_id) as any;
  if (existing) { res.status(400).json({ error: 'Student is already in a buddy group' }); return; }

  try {
    db.prepare('INSERT OR IGNORE INTO buddy_group_members (buddy_group_id, student_id) VALUES (?, ?)').run(req.params.id, student_id);
    res.json({ success: true });
  } catch (err: any) {
    throw err;
  }
});

// Remove a member from a buddy group
router.delete('/:id/members/:studentId', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM buddy_groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Buddy group not found' }); return; }

  db.prepare('DELETE FROM buddy_group_members WHERE buddy_group_id = ? AND student_id = ?').run(req.params.id, req.params.studentId);
  res.json({ success: true });
});

// Search students not in a buddy group (for adding members)
router.get('/:id/non-members', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM buddy_groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Buddy group not found' }); return; }

  const q = (req.query.q as string || '').trim();
  if (!q) { res.json([]); return; }

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.email
    FROM students s
    WHERE s.active = 1
      AND s.id NOT IN (SELECT student_id FROM buddy_group_members)
      AND (s.first_name || ' ' || s.last_name LIKE ? OR s.email LIKE ?)
    ORDER BY s.last_name ASC, s.first_name ASC
    LIMIT 20
  `).all(`%${q}%`, `%${q}%`);
  res.json(students);
});

export default router;
