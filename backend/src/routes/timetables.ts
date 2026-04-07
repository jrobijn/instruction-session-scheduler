import { Router, Request, Response } from 'express';
import db from '../database.js';

const router = Router();

// List all timetables
router.get('/', (_req: Request, res: Response) => {
  const timetables = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM timeslots WHERE timetable_id = t.id) AS timeslot_count
    FROM timetables t
    ORDER BY t.created_at DESC
  `).all();
  res.json(timetables);
});

// Get single timetable with timeslots and groups
router.get('/:id', (req: Request, res: Response) => {
  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }

  const timeslots = db.prepare(
    'SELECT * FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC'
  ).all(req.params.id);

  const groups = db.prepare(`
    SELECT tg.group_id, tg.percentage, g.name AS group_name, g.priority, g.is_default, g.color AS group_color
    FROM timetable_groups tg
    JOIN groups g ON g.id = tg.group_id
    WHERE tg.timetable_id = ?
    ORDER BY g.priority ASC
  `).all(req.params.id);

  res.json({ ...timetable, timeslots, groups });
});

// Create timetable
router.post('/', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) { res.status(400).json({ error: 'Name is required' }); return; }

  const result = db.prepare('INSERT INTO timetables (name) VALUES (?)').run(name);
  const timetableId = result.lastInsertRowid;
  // Auto-assign default group at 100%
  const defaultGroup = db.prepare("SELECT id FROM groups WHERE is_default = 1").get() as { id: number } | undefined;
  if (defaultGroup) {
    db.prepare('INSERT INTO timetable_groups (timetable_id, group_id, percentage) VALUES (?, ?, 100)').run(timetableId, defaultGroup.id);
  }
  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(timetableId);
  res.status(201).json(timetable);
});

// Update timetable (name only, and only if draft)
router.put('/:id', (req: Request, res: Response) => {
  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }

  const { name } = req.body;
  if (name !== undefined) {
    if (timetable.status !== 'draft') {
      res.status(400).json({ error: 'Cannot edit a saved timetable' });
      return;
    }
    db.prepare('UPDATE timetables SET name = ? WHERE id = ?').run(name, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Save (finalize) timetable: draft → saved
router.post('/:id/save', (req: Request, res: Response) => {
  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }
  if (timetable.status !== 'draft') { res.status(400).json({ error: 'Timetable is already saved' }); return; }

  const timeslotCount = (db.prepare('SELECT COUNT(*) AS cnt FROM timeslots WHERE timetable_id = ?').get(req.params.id) as any).cnt;
  if (timeslotCount === 0) { res.status(400).json({ error: 'Cannot save a timetable with no timeslots' }); return; }

  // Validate groups are assigned and percentages sum to 100
  const groups = db.prepare('SELECT percentage FROM timetable_groups WHERE timetable_id = ?').all(req.params.id) as Array<{ percentage: number }>;
  if (groups.length === 0) { res.status(400).json({ error: 'At least one group must be assigned' }); return; }
  const totalPct = groups.reduce((sum, g) => sum + g.percentage, 0);
  if (totalPct !== 100) { res.status(400).json({ error: `Group percentages must add up to 100% (currently ${totalPct}%)` }); return; }

  db.prepare("UPDATE timetables SET status = 'saved' WHERE id = ?").run(req.params.id);
  const updated = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Set timetable as default
router.post('/:id/set-default', (req: Request, res: Response) => {
  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }
  if (!timetable.active) { res.status(400).json({ error: 'Cannot set an inactive timetable as default' }); return; }
  if (timetable.status !== 'saved') { res.status(400).json({ error: 'Only saved timetables can be set as default' }); return; }

  db.prepare('UPDATE timetables SET is_default = 0 WHERE is_default = 1').run();
  db.prepare('UPDATE timetables SET is_default = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Toggle active/inactive
router.post('/:id/toggle-active', (req: Request, res: Response) => {
  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }

  const newActive = timetable.active ? 0 : 1;
  db.prepare('UPDATE timetables SET active = ? WHERE id = ?').run(newActive, req.params.id);

  // If deactivating the default, clear the default flag
  if (!newActive && timetable.is_default) {
    db.prepare('UPDATE timetables SET is_default = 0 WHERE id = ?').run(req.params.id);
  }

  res.json({ success: true, active: newActive });
});

// Delete timetable (with constraints)
router.delete('/:id', (req: Request, res: Response) => {
  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }

  // Block deletion if attached to sessions with sent invitations or completed
  const blockingCount = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM training_sessions
    WHERE timetable_id = ? AND status IN ('invitations_sent', 'completed')
  `).get(req.params.id) as any).cnt;

  if (blockingCount > 0) {
    res.status(400).json({ error: 'Cannot delete: timetable is attached to sessions with sent invitations or completed sessions' });
    return;
  }

  // Clear scheduled sessions that use this timetable
  const scheduledSessions = db.prepare(
    "SELECT id FROM training_sessions WHERE timetable_id = ? AND status = 'scheduled'"
  ).all(req.params.id) as Array<{ id: number }>;

  const deleteTransaction = db.transaction(() => {
    for (const sess of scheduledSessions) {
      db.prepare('DELETE FROM invitations WHERE session_id = ?').run(sess.id);
      db.prepare("UPDATE training_sessions SET status = 'draft', timetable_id = NULL WHERE id = ?").run(sess.id);
    }

    // Null out timetable_id for draft sessions
    db.prepare("UPDATE training_sessions SET timetable_id = NULL WHERE timetable_id = ? AND status = 'draft'").run(req.params.id);

    // Delete the timetable (CASCADE deletes its timeslots)
    db.prepare('DELETE FROM timetables WHERE id = ?').run(req.params.id);
  });

  deleteTransaction();
  res.json({ success: true });
});

// ===== Group Assignment =====

// Set groups for a timetable (draft only)
router.put('/:id/groups', (req: Request, res: Response) => {
  const { groups } = req.body;
  if (!Array.isArray(groups)) { res.status(400).json({ error: 'groups array is required' }); return; }

  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }
  if (timetable.status !== 'draft') { res.status(400).json({ error: 'Cannot modify groups of a saved timetable' }); return; }

  const setGroups = db.transaction(() => {
    db.prepare('DELETE FROM timetable_groups WHERE timetable_id = ?').run(req.params.id);
    const insert = db.prepare('INSERT INTO timetable_groups (timetable_id, group_id, percentage) VALUES (?, ?, ?)');
    for (const g of groups) {
      insert.run(req.params.id, g.group_id, g.percentage);
    }
  });

  setGroups();
  res.json({ success: true });
});

// ===== Timeslot Management =====

// Add timeslot to timetable (draft only)
router.post('/:id/timeslots', (req: Request, res: Response) => {
  const { start_time } = req.body;
  if (!start_time) { res.status(400).json({ error: 'start_time is required' }); return; }

  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }
  if (timetable.status !== 'draft') { res.status(400).json({ error: 'Cannot modify timeslots of a saved timetable' }); return; }

  try {
    const result = db.prepare('INSERT INTO timeslots (timetable_id, start_time) VALUES (?, ?)').run(req.params.id, start_time);
    const timeslot = db.prepare('SELECT * FROM timeslots WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(timeslot);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A timeslot with this start time already exists in this timetable' });
      return;
    }
    throw err;
  }
});

// Delete timeslot from timetable (draft only)
router.delete('/:id/timeslots/:timeslotId', (req: Request, res: Response) => {
  const timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(req.params.id) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }
  if (timetable.status !== 'draft') { res.status(400).json({ error: 'Cannot modify timeslots of a saved timetable' }); return; }

  const result = db.prepare('DELETE FROM timeslots WHERE id = ? AND timetable_id = ?')
    .run(req.params.timeslotId, req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Timeslot not found' }); return; }
  res.json({ success: true });
});

export default router;
