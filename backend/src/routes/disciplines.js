import { Router } from 'express';
import db from '../database.js';

const router = Router();

// List all disciplines
router.get('/', (req, res) => {
  const disciplines = db.prepare('SELECT * FROM disciplines ORDER BY name ASC').all();
  res.json(disciplines);
});

// Get single discipline
router.get('/:id', (req, res) => {
  const discipline = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(req.params.id);
  if (!discipline) return res.status(404).json({ error: 'Discipline not found' });
  res.json(discipline);
});

// Create discipline
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    const result = db.prepare('INSERT INTO disciplines (name) VALUES (?)').run(name);
    const discipline = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(discipline);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A discipline with this name already exists' });
    }
    throw err;
  }
});

// Update discipline
router.put('/:id', (req, res) => {
  const { name, active } = req.body;
  const discipline = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(req.params.id);
  if (!discipline) return res.status(404).json({ error: 'Discipline not found' });

  try {
    db.prepare(`
      UPDATE disciplines SET
        name = COALESCE(?, name),
        active = COALESCE(?, active)
      WHERE id = ?
    `).run(name ?? null, active ?? null, req.params.id);

    const updated = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A discipline with this name already exists' });
    }
    throw err;
  }
});

// Delete discipline
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM disciplines WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Discipline not found' });
  res.json({ success: true });
});

export default router;
