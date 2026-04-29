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

// List all students
router.get('/', (_req: Request, res: Response) => {
  const students = db.prepare('SELECT * FROM students ORDER BY last_name ASC, first_name ASC').all() as any[];
  // Attach group names for each student
  const groupMemberships = db.prepare(`
    SELECT sg.student_id, g.id AS group_id, g.name AS group_name, g.color AS group_color
    FROM student_groups sg
    JOIN groups g ON g.id = sg.group_id
    ORDER BY g.priority ASC
  `).all() as Array<{ student_id: number; group_id: number; group_name: string; group_color: string | null }>;
  const groupsByStudent = new Map<number, Array<{ id: number; name: string; color: string | null }>>();
  for (const m of groupMemberships) {
    if (!groupsByStudent.has(m.student_id)) groupsByStudent.set(m.student_id, []);
    groupsByStudent.get(m.student_id)!.push({ id: m.group_id, name: m.group_name, color: m.group_color });
  }
  const result = students.map(s => ({ ...s, groups: groupsByStudent.get(s.id) || [] }));
  res.json(result);
});

// Export students as CSV
router.get('/export', (_req: Request, res: Response) => {
  const students = db.prepare('SELECT first_name, last_name, email, membership_id, attended_sessions, no_show_count, priority, preferred_days, active FROM students ORDER BY last_name ASC, first_name ASC').all() as { first_name: string; last_name: string; email: string; membership_id: string; attended_sessions: number; no_show_count: number; priority: number; preferred_days: string; active: number }[];
  const header = 'first_name,last_name,email,membership_id,attended_sessions,no_show_count,priority,preferred_days,active';
  const rows = students.map(s => [s.first_name, s.last_name, s.email, s.membership_id, s.attended_sessions, s.no_show_count, s.priority, s.preferred_days, s.active].map(escapeCsvField).join(','));
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
  res.send(csv);
});

// Bulk update student priorities
router.put('/priorities', (req: Request, res: Response) => {
  const { updates } = req.body;
  if (!Array.isArray(updates)) { res.status(400).json({ error: 'updates array is required' }); return; }

  const update = db.prepare('UPDATE students SET priority = ? WHERE id = ?');
  const run = db.transaction(() => {
    for (const { id, priority } of updates) {
      if (typeof id === 'number' && typeof priority === 'number' && priority >= 0) {
        update.run(priority, id);
      }
    }
    // Normalize so the minimum active student has priority 1
    const minPriority = (db.prepare(
      "SELECT MIN(priority) AS m FROM students WHERE active = 1 AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))"
    ).get() as any)?.m;
    if (minPriority != null && minPriority !== 1) {
      db.prepare('UPDATE students SET priority = priority - ?').run(minPriority - 1);
    }
  });
  run();
  res.json({ success: true, count: updates.length });
});

// Import students from CSV
router.post('/import', (req: Request, res: Response) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== 'string') { res.status(400).json({ error: 'CSV data is required' }); return; }

  const lines = csv.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) { res.status(400).json({ error: 'CSV must have a header row and at least one data row' }); return; }

  const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const firstNameIdx = header.indexOf('first_name');
  const lastNameIdx = header.indexOf('last_name');
  const emailIdx = header.indexOf('email');
  const membershipIdIdx = header.indexOf('membership_id');
  const attendedSessionsIdx = header.indexOf('attended_sessions');
  const noShowCountIdx = header.indexOf('no_show_count');
  const priorityIdx = header.indexOf('priority');
  const preferredDaysIdx = header.indexOf('preferred_days');
  const activeIdx = header.indexOf('active');

  if (firstNameIdx === -1 || lastNameIdx === -1 || emailIdx === -1) {
    res.status(400).json({ error: 'CSV must contain first_name, last_name, and email columns' }); return;
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
    const defaultGroup = db.prepare("SELECT id FROM groups WHERE is_default = 1").get() as { id: number } | undefined;

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      const first_name = fields[firstNameIdx]?.trim();
      const last_name = fields[lastNameIdx]?.trim();
      const email = fields[emailIdx]?.trim();
      const membership_id = membershipIdIdx !== -1 ? (fields[membershipIdIdx]?.trim() || '') : '';
      const attended_sessions = attendedSessionsIdx !== -1 ? parseInt(fields[attendedSessionsIdx]?.trim(), 10) : undefined;
      const no_show_count = noShowCountIdx !== -1 ? parseInt(fields[noShowCountIdx]?.trim(), 10) : undefined;
      const priority = priorityIdx !== -1 ? parseInt(fields[priorityIdx]?.trim(), 10) : undefined;
      const preferred_days = preferredDaysIdx !== -1 ? (fields[preferredDaysIdx]?.trim() || '') : '';
      const active = activeIdx !== -1 ? parseInt(fields[activeIdx]?.trim(), 10) : undefined;

      if (!first_name || !last_name || !email) {
        errors.push(`Row ${i + 1}: missing required fields`);
        skipped++;
        continue;
      }

      try {
        const existing = db.prepare('SELECT id FROM students WHERE email = ?').get(email) as { id: number } | undefined;
        if (existing) {
          db.prepare(`UPDATE students SET first_name = ?, last_name = ?, membership_id = ?${
            attended_sessions != null && !isNaN(attended_sessions) ? ', attended_sessions = ?' : ''
          }${no_show_count != null && !isNaN(no_show_count) ? ', no_show_count = ?' : ''
          }${priority != null && !isNaN(priority) ? ', priority = ?' : ''
          }${preferred_days ? ', preferred_days = ?' : ''
          }${active != null && !isNaN(active) ? ', active = ?' : ''
          } WHERE id = ?`).run(
            first_name, last_name, membership_id,
            ...(attended_sessions != null && !isNaN(attended_sessions) ? [attended_sessions] : []),
            ...(no_show_count != null && !isNaN(no_show_count) ? [no_show_count] : []),
            ...(priority != null && !isNaN(priority) ? [priority] : []),
            ...(preferred_days ? [preferred_days] : []),
            ...(active != null && !isNaN(active) ? [active] : []),
            existing.id
          );
          if (defaultGroup) {
            db.prepare('INSERT OR IGNORE INTO student_groups (student_id, group_id) VALUES (?, ?)').run(existing.id, defaultGroup.id);
          }
        } else {
          const result = db.prepare(`INSERT INTO students (first_name, last_name, email, membership_id${
            attended_sessions != null && !isNaN(attended_sessions) ? ', attended_sessions' : ''
          }${no_show_count != null && !isNaN(no_show_count) ? ', no_show_count' : ''
          }${priority != null && !isNaN(priority) ? ', priority' : ''
          }${preferred_days ? ', preferred_days' : ''
          }${active != null && !isNaN(active) ? ', active' : ''
          }) VALUES (?, ?, ?, ?${
            attended_sessions != null && !isNaN(attended_sessions) ? ', ?' : ''
          }${no_show_count != null && !isNaN(no_show_count) ? ', ?' : ''
          }${priority != null && !isNaN(priority) ? ', ?' : ''
          }${preferred_days ? ', ?' : ''
          }${active != null && !isNaN(active) ? ', ?' : ''
          })`).run(
            first_name, last_name, email, membership_id,
            ...(attended_sessions != null && !isNaN(attended_sessions) ? [attended_sessions] : []),
            ...(no_show_count != null && !isNaN(no_show_count) ? [no_show_count] : []),
            ...(priority != null && !isNaN(priority) ? [priority] : []),
            ...(preferred_days ? [preferred_days] : []),
            ...(active != null && !isNaN(active) ? [active] : []),
          );
          if (defaultGroup) {
            db.prepare('INSERT OR IGNORE INTO student_groups (student_id, group_id) VALUES (?, ?)').run(result.lastInsertRowid, defaultGroup.id);
          }
        }
        imported++;
      } catch (err: any) {
        errors.push(`Row ${i + 1}: ${err.message}`);
        skipped++;
      }
    }
  });

  insertOrUpdate();
  res.json({ imported, skipped, errors });
});

// Get single student
router.get('/:id', (req: Request, res: Response) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }
  res.json(student);
});

// Create student
router.post('/', (req: Request, res: Response) => {
  const { first_name, last_name, email, membership_id } = req.body;
  if (!first_name || !last_name || !email) { res.status(400).json({ error: 'First name, last name and email are required' }); return; }

  try {
    const result = db.prepare('INSERT INTO students (first_name, last_name, email, membership_id) VALUES (?, ?, ?, ?)').run(first_name, last_name, email, membership_id || '');
    const studentId = result.lastInsertRowid;
    // Auto-add to default group
    const defaultGroup = db.prepare("SELECT id FROM groups WHERE is_default = 1").get() as { id: number } | undefined;
    if (defaultGroup) {
      db.prepare('INSERT OR IGNORE INTO student_groups (student_id, group_id) VALUES (?, ?)').run(studentId, defaultGroup.id);
    }
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
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
  const { first_name, last_name, email, membership_id, attended_sessions, active, preferred_days } = req.body;
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  try {
    db.prepare(`
      UPDATE students SET
        first_name = COALESCE(?, first_name),
        last_name = COALESCE(?, last_name),
        email = COALESCE(?, email),
        membership_id = COALESCE(?, membership_id),
        attended_sessions = COALESCE(?, attended_sessions),
        active = COALESCE(?, active),
        preferred_days = COALESCE(?, preferred_days)
      WHERE id = ?
    `).run(first_name ?? null, last_name ?? null, email ?? null, membership_id ?? null, attended_sessions ?? null, active ?? null, preferred_days ?? null, req.params.id);

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

// ===== Preferred Timeslots =====

// Get preferred timeslots for a student (grouped by timetable)
router.get('/:id/preferred-timeslots', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const rows = db.prepare(
    'SELECT timetable_id, timeslot_id FROM student_preferred_timeslots WHERE student_id = ?'
  ).all(req.params.id) as Array<{ timetable_id: number; timeslot_id: number }>;

  // Group by timetable_id
  const byTimetable: Record<number, number[]> = {};
  for (const r of rows) {
    if (!byTimetable[r.timetable_id]) byTimetable[r.timetable_id] = [];
    byTimetable[r.timetable_id].push(r.timeslot_id);
  }

  res.json(byTimetable);
});

// Set preferred timeslots for a student for a specific timetable
router.put('/:id/preferred-timeslots/:timetableId', (req: Request, res: Response) => {
  const { timeslot_ids } = req.body;
  if (!Array.isArray(timeslot_ids)) { res.status(400).json({ error: 'timeslot_ids array is required' }); return; }

  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const timetable = db.prepare('SELECT id FROM timetables WHERE id = ?').get(req.params.timetableId) as any;
  if (!timetable) { res.status(404).json({ error: 'Timetable not found' }); return; }

  // Get all timeslot IDs for this timetable
  const allTimeslots = db.prepare('SELECT id FROM timeslots WHERE timetable_id = ?')
    .all(req.params.timetableId) as Array<{ id: number }>;
  const allIds = new Set(allTimeslots.map(t => t.id));

  // If all timeslots are selected, clear preferences (= default all)
  const setTransaction = db.transaction(() => {
    db.prepare('DELETE FROM student_preferred_timeslots WHERE student_id = ? AND timetable_id = ?')
      .run(req.params.id, req.params.timetableId);

    if (timeslot_ids.length < allIds.size) {
      const insert = db.prepare(
        'INSERT INTO student_preferred_timeslots (student_id, timeslot_id, timetable_id) VALUES (?, ?, ?)'
      );
      for (const tsId of timeslot_ids) {
        if (allIds.has(tsId)) {
          insert.run(req.params.id, tsId, req.params.timetableId);
        }
      }
    }
  });

  setTransaction();
  res.json({ success: true });
});

// ===== Group Membership =====

// Get groups for a student
router.get('/:id/groups', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const groups = db.prepare(`
    SELECT g.id, g.name, g.priority, g.is_default FROM groups g
    JOIN student_groups sg ON sg.group_id = g.id
    WHERE sg.student_id = ?
    ORDER BY g.priority ASC
  `).all(req.params.id);
  res.json(groups);
});

// Set groups for a student (replaces all non-default memberships + always keeps default)
router.put('/:id/groups', (req: Request, res: Response) => {
  const { group_ids } = req.body;
  if (!Array.isArray(group_ids)) { res.status(400).json({ error: 'group_ids array is required' }); return; }

  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const defaultGroup = db.prepare("SELECT id FROM groups WHERE is_default = 1").get() as { id: number };

  const setGroups = db.transaction(() => {
    // Remove all non-default memberships
    db.prepare('DELETE FROM student_groups WHERE student_id = ? AND group_id != ?')
      .run(req.params.id, defaultGroup.id);
    // Ensure default group membership
    db.prepare('INSERT OR IGNORE INTO student_groups (student_id, group_id) VALUES (?, ?)')
      .run(req.params.id, defaultGroup.id);
    // Add requested groups
    const insert = db.prepare('INSERT OR IGNORE INTO student_groups (student_id, group_id) VALUES (?, ?)');
    for (const gid of group_ids) {
      if (gid !== defaultGroup.id) {
        insert.run(req.params.id, gid);
      }
    }
  });

  setGroups();
  res.json({ success: true });
});

// ===== Cooldowns =====

// Set cooldown for a student (days from now)
router.put('/:id/cooldown', (req: Request, res: Response) => {
  const { days } = req.body;
  if (typeof days !== 'number' || days <= 0) { res.status(400).json({ error: 'A positive number of days is required' }); return; }

  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const cooldownUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
  db.prepare('UPDATE students SET cooldown_until = ? WHERE id = ?').run(cooldownUntil, req.params.id);

  const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Clear cooldown for a student
router.delete('/:id/cooldown', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  db.prepare('UPDATE students SET cooldown_until = NULL WHERE id = ?').run(req.params.id);

  const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  res.json(updated);
});

export default router;
