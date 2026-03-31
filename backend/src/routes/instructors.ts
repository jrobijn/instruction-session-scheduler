import { Router, Request, Response } from 'express';
import db from '../database.js';

const router = Router();

// List all instructors
router.get('/', (_req: Request, res: Response) => {
  const instructors = db.prepare('SELECT * FROM instructors ORDER BY name ASC').all();
  res.json(instructors);
});

// Get single instructor
router.get('/:id', (req: Request, res: Response) => {
  const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(req.params.id);
  if (!instructor) { res.status(404).json({ error: 'Instructor not found' }); return; }
  res.json(instructor);
});

// Create instructor
router.post('/', (req: Request, res: Response) => {
  const { name, email } = req.body;
  if (!name || !email) { res.status(400).json({ error: 'Name and email are required' }); return; }

  try {
    const result = db.prepare('INSERT INTO instructors (name, email) VALUES (?, ?)').run(name, email);
    const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(instructor);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'An instructor with this email already exists' });
      return;
    }
    throw err;
  }
});

// Update instructor
router.put('/:id', (req: Request, res: Response) => {
  const { name, email, active } = req.body;
  const instructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(req.params.id);
  if (!instructor) { res.status(404).json({ error: 'Instructor not found' }); return; }

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
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'An instructor with this email already exists' });
      return;
    }
    throw err;
  }
});

// Delete instructor
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM instructors WHERE id = ?').run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Instructor not found' }); return; }
  res.json({ success: true });
});

export default router;
