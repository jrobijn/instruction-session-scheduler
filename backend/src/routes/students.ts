import { Router, Request, Response } from 'express';
import db from '../database.js';

const router = Router();

// List all students
router.get('/', (_req: Request, res: Response) => {
  const students = db.prepare('SELECT * FROM students ORDER BY last_name ASC, first_name ASC').all();
  res.json(students);
});

// Get single student
router.get('/:id', (req: Request, res: Response) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }
  res.json(student);
});

// Create student
router.post('/', (req: Request, res: Response) => {
  const { first_name, last_name, email } = req.body;
  if (!first_name || !last_name || !email) { res.status(400).json({ error: 'First name, last name and email are required' }); return; }

  try {
    const result = db.prepare('INSERT INTO students (first_name, last_name, email) VALUES (?, ?, ?)').run(first_name, last_name, email);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(student);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A student with this email already exists' });
      return;
    }
    throw err;
  }
});

// Update student
router.put('/:id', (req: Request, res: Response) => {
  const { first_name, last_name, email, attended_sessions, active } = req.body;
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  try {
    db.prepare(`
      UPDATE students SET
        first_name = COALESCE(?, first_name),
        last_name = COALESCE(?, last_name),
        email = COALESCE(?, email),
        attended_sessions = COALESCE(?, attended_sessions),
        active = COALESCE(?, active)
      WHERE id = ?
    `).run(first_name ?? null, last_name ?? null, email ?? null, attended_sessions ?? null, active ?? null, req.params.id);

    const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A student with this email already exists' });
      return;
    }
    throw err;
  }
});

// Delete student
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Student not found' }); return; }
  res.json({ success: true });
});

export default router;
