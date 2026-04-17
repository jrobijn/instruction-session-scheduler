import { Router, Request, Response } from 'express';
import db from '../database.js';

let onCheckIntervalChanged: (() => void) | null = null;
export function setCheckIntervalChangedCallback(cb: () => void) {
  onCheckIntervalChanged = cb;
}

const router = Router();

// Get all settings
router.get('/', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM settings').all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  res.json(settings);
});

// Update a setting
router.put('/:key', (req: Request, res: Response) => {
  const { value } = req.body;
  if (value === undefined) { res.status(400).json({ error: 'Value is required' }); return; }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(req.params.key, String(value));

  if (req.params.key === 'invitation_check_interval_minutes' && onCheckIntervalChanged) {
    onCheckIntervalChanged();
  }

  res.json({ key: req.params.key, value: String(value) });
});

export default router;
