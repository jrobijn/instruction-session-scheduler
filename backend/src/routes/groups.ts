import { Router, Request, Response } from 'express';
import db from '../database.js';

const router = Router();

function escapeCsvField(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// List all groups
router.get('/', (_req: Request, res: Response) => {
  const groups = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM student_groups WHERE group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM discipline_groups WHERE group_id = g.id) AS discipline_count
    FROM groups g
    ORDER BY g.name ASC
  `).all();
  res.json(groups);
});

// Export groups as CSV
router.get('/export', (_req: Request, res: Response) => {
  const groups = db.prepare('SELECT name, is_default, active FROM groups ORDER BY name ASC').all() as Array<{ name: string; is_default: number; active: number }>;
  const header = 'name,is_default,active';
  const rows = groups.map(g => [g.name, g.is_default, g.active].map(escapeCsvField).join(','));
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="groups.csv"');
  res.send(csv);
});

// Import groups from CSV
router.post('/import', (req: Request, res: Response) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== 'string') { res.status(400).json({ error: 'CSV data is required' }); return; }

  const lines = csv.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) { res.status(400).json({ error: 'CSV must have a header row and at least one data row' }); return; }

  const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const nameIdx = header.indexOf('name');

  if (nameIdx === -1) {
    res.status(400).json({ error: 'CSV must contain a name column' }); return;
  }

  const parseCsvLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { fields.push(current.trim()); current = ''; }
        else { current += ch; }
      }
    }
    fields.push(current.trim());
    return fields;
  };

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  const insertOrUpdate = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      const name = fields[nameIdx]?.trim();

      if (!name) {
        errors.push(`Row ${i + 1}: missing name`);
        skipped++;
        continue;
      }

      try {
        const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined;
        if (existing) {
          skipped++;
        } else {
          db.prepare('INSERT INTO groups (name) VALUES (?)').run(name);
          imported++;
        }
      } catch (err: any) {
        errors.push(`Row ${i + 1}: ${err.message}`);
        skipped++;
      }
    }
  });

  insertOrUpdate();
  res.json({ imported, skipped, errors });
});

// Create group
router.post('/', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) { res.status(400).json({ error: 'Name is required' }); return; }

  try {
    const result = db.prepare('INSERT INTO groups (name, color) VALUES (?, ?)').run(name, req.body.color || '#3b82f6');
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(group);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A group with this name already exists' });
      return;
    }
    throw err;
  }
});

// Update group
router.put('/:id', (req: Request, res: Response) => {
  const { name, active } = req.body;
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  try {
    db.prepare(`
      UPDATE groups SET
        name = COALESCE(?, name),
        active = COALESCE(?, active),
        color = COALESCE(?, color)
      WHERE id = ?
    `).run(name ?? null, active ?? null, req.body.color ?? null, req.params.id);

    const updated = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A group with this name already exists' });
      return;
    }
    throw err;
  }
});

// Delete group
router.delete('/:id', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  // Check if assigned to any timetable
  const timetableCount = (db.prepare('SELECT COUNT(*) AS cnt FROM timetable_groups WHERE group_id = ?').get(req.params.id) as any).cnt;
  if (timetableCount > 0) {
    res.status(400).json({ error: 'Cannot delete a group that is assigned to timetables' }); return;
  }

  db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Set a group as the default (new students are auto-added)
router.post('/:id/set-default', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  db.prepare('UPDATE groups SET is_default = 0 WHERE is_default = 1').run();
  db.prepare('UPDATE groups SET is_default = 1 WHERE id = ?').run(req.params.id);
  const updated = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Unset the default group
router.post('/:id/unset-default', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  db.prepare('UPDATE groups SET is_default = 0 WHERE id = ?').run(req.params.id);
  const updated = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Get members of a group
router.get('/:id/members', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const members = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.email, s.active
    FROM students s
    JOIN student_groups sg ON sg.student_id = s.id
    WHERE sg.group_id = ?
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all(req.params.id);
  res.json(members);
});

// Add a member to a group (replaces their current group since students can only be in one)
router.post('/:id/members', (req: Request, res: Response) => {
  const { student_id } = req.body;
  if (!student_id) { res.status(400).json({ error: 'student_id is required' }); return; }

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(student_id) as any;
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const setGroup = db.transaction(() => {
    db.prepare('DELETE FROM student_groups WHERE student_id = ?').run(student_id);
    db.prepare('INSERT INTO student_groups (student_id, group_id) VALUES (?, ?)').run(student_id, req.params.id);
  });
  setGroup();
  res.json({ success: true });
});

// Remove a member from a group
router.delete('/:id/members/:studentId', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  db.prepare('DELETE FROM student_groups WHERE student_id = ? AND group_id = ?').run(req.params.studentId, req.params.id);
  res.json({ success: true });
});

// Search students not in a group (for adding members)
router.get('/:id/non-members', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const q = (req.query.q as string || '').trim();
  if (!q) { res.json([]); return; }

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.email
    FROM students s
    WHERE s.active = 1
      AND s.id NOT IN (SELECT student_id FROM student_groups WHERE group_id = ?)
      AND (s.first_name || ' ' || s.last_name LIKE ? OR s.email LIKE ?)
    ORDER BY s.last_name ASC, s.first_name ASC
    LIMIT 20
  `).all(req.params.id, `%${q}%`, `%${q}%`);
  res.json(students);
});

// Get disciplines assigned to a group
router.get('/:id/disciplines', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const disciplines = db.prepare(`
    SELECT d.id, d.name, d.abbreviation, d.active
    FROM disciplines d
    JOIN discipline_groups dg ON dg.discipline_id = d.id
    WHERE dg.group_id = ?
    ORDER BY d.name ASC
  `).all(req.params.id);
  res.json(disciplines);
});

// Add a discipline to a group
router.post('/:id/disciplines/:disciplineId', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const discipline = db.prepare('SELECT id FROM disciplines WHERE id = ?').get(req.params.disciplineId) as any;
  if (!discipline) { res.status(404).json({ error: 'Discipline not found' }); return; }

  try {
    db.prepare('INSERT INTO discipline_groups (discipline_id, group_id) VALUES (?, ?)').run(req.params.disciplineId, req.params.id);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Already assigned' }); return;
    }
    throw err;
  }
  res.json({ success: true });
});

// Remove a discipline from a group
router.delete('/:id/disciplines/:disciplineId', (req: Request, res: Response) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  db.prepare('DELETE FROM discipline_groups WHERE discipline_id = ? AND group_id = ?').run(req.params.disciplineId, req.params.id);
  res.json({ success: true });
});

export default router;
