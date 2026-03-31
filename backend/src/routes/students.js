import { Router } from 'express';
import db from '../database.js';

const router = Router();

// List all students
router.get('/', (req, res) => {
  const students = db.prepare(`
    SELECT * FROM students ORDER BY name ASC
  `).all();
  res.json(students);
});

// Get single student
router.get('/:id', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json(student);
});

// Create student
router.post('/', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  try {
    const result = db.prepare('INSERT INTO students (name, email) VALUES (?, ?)').run(name, email);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(student);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A student with this email already exists' });
    }
    throw err;
  }
});

// Update student
router.put('/:id', (req, res) => {
  const { name, email, attended_sessions, active } = req.body;
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  try {
    db.prepare(`
      UPDATE students SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        attended_sessions = COALESCE(?, attended_sessions),
        active = COALESCE(?, active)
      WHERE id = ?
    `).run(name ?? null, email ?? null, attended_sessions ?? null, active ?? null, req.params.id);

    const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A student with this email already exists' });
    }
    throw err;
  }
});

// Delete student
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Student not found' });
  res.json({ success: true });
});

export default router;
