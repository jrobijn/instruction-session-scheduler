import { Router, Request, Response } from 'express';
import db from '../database.js';

const router = Router();

// List all disciplines
router.get('/', (_req: Request, res: Response) => {
  const disciplines = db.prepare('SELECT * FROM disciplines ORDER BY name ASC').all();
  res.json(disciplines);
});

// Get single discipline
router.get('/:id', (req: Request, res: Response) => {
  const discipline = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(req.params.id);
  if (!discipline) { res.status(404).json({ error: 'Discipline not found' }); return; }
  res.json(discipline);
});

// Create discipline
router.post('/', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) { res.status(400).json({ error: 'Name is required' }); return; }

  try {
    const result = db.prepare('INSERT INTO disciplines (name) VALUES (?)').run(name);
    const discipline = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(discipline);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A discipline with this name already exists' });
      return;
    }
    throw err;
  }
});

// Update discipline
router.put('/:id', (req: Request, res: Response) => {
  const { name, active } = req.body;
  const discipline = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(req.params.id);
  if (!discipline) { res.status(404).json({ error: 'Discipline not found' }); return; }

  try {
    db.prepare(`
      UPDATE disciplines SET
        name = COALESCE(?, name),
        active = COALESCE(?, active)
      WHERE id = ?
    `).run(name ?? null, active ?? null, req.params.id);

    const updated = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A discipline with this name already exists' });
      return;
    }
    throw err;
  }
});

// Delete discipline
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM disciplines WHERE id = ?').run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Discipline not found' }); return; }
  res.json({ success: true });
});

export default router;
