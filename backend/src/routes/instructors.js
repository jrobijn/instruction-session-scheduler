import { Router } from 'express';
import db from '../database.js';

const router = Router();

// List all instructors
router.get('/', (req, res) => {
  const instructors = db.prepare('SELECT * FROM instructors ORDER BY name ASC').all();
  res.json(instructors);
});

// Get single instructor
router.get('/:id', (req, res) => {
  const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(req.params.id);
  if (!instructor) return res.status(404).json({ error: 'Instructor not found' });
  res.json(instructor);
});

// Create instructor
router.post('/', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  try {
    const result = db.prepare('INSERT INTO instructors (name, email) VALUES (?, ?)').run(name, email);
    const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(instructor);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'An instructor with this email already exists' });
    }
    throw err;
  }
});

// Update instructor
router.put('/:id', (req, res) => {
  const { name, email, active } = req.body;
  const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(req.params.id);
  if (!instructor) return res.status(404).json({ error: 'Instructor not found' });

  try {
    db.prepare(`
      UPDATE instructors SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        active = COALESCE(?, active)
      WHERE id = ?
    `).run(name ?? null, email ?? null, active ?? null, req.params.id);

    const updated = db.prepare('SELECT * FROM instructors WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'An instructor with this email already exists' });
    }
    throw err;
  }
});

// Delete instructor
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM instructors WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Instructor not found' });
  res.json({ success: true });
});

export default router;
