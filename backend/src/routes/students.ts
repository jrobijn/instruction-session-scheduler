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
  const students = db.prepare('SELECT * FROM students WHERE deleted_at IS NULL ORDER BY last_name ASC, first_name ASC').all() as any[];
  // Attach group for each student (single group per student)
  const groupMemberships = db.prepare(`
    SELECT sg.student_id, g.id AS group_id, g.name AS group_name, g.color AS group_color
    FROM student_groups sg
    JOIN groups g ON g.id = sg.group_id
  `).all() as Array<{ student_id: number; group_id: number; group_name: string; group_color: string | null }>;
  const groupByStudent = new Map<number, { id: number; name: string; color: string | null }>();
  for (const m of groupMemberships) {
    groupByStudent.set(m.student_id, { id: m.group_id, name: m.group_name, color: m.group_color });
  }
  // Attach buddy group for each student (name computed from member first names)
  const buddyMemberships = db.prepare(`
    SELECT bgm.student_id, bgm.buddy_group_id
    FROM buddy_group_members bgm
  `).all() as Array<{ student_id: number; buddy_group_id: number }>;
  // Build map of group_id -> member first names
  const buddyGroupMembers = new Map<number, string[]>();
  for (const m of buddyMemberships) {
    const student = students.find(s => s.id === m.student_id) as any;
    if (student) {
      if (!buddyGroupMembers.has(m.buddy_group_id)) buddyGroupMembers.set(m.buddy_group_id, []);
      buddyGroupMembers.get(m.buddy_group_id)!.push(student.first_name);
    }
  }
  const buddyByStudent = new Map<number, { id: number; name: string }>();
  for (const m of buddyMemberships) {
    const names = buddyGroupMembers.get(m.buddy_group_id) || [];
    buddyByStudent.set(m.student_id, { id: m.buddy_group_id, name: names.join(' & ') });
  }
  const result = students.map(s => ({ ...s, group: groupByStudent.get(s.id) || null, buddy_group: buddyByStudent.get(s.id) || null }));
  res.json(result);
});

// Export students as CSV
router.get('/export', (_req: Request, res: Response) => {
  const students = db.prepare('SELECT first_name, last_name, email, membership_id, attended_sessions, no_show_count, preferred_days, active FROM students WHERE deleted_at IS NULL ORDER BY last_name ASC, first_name ASC').all() as { first_name: string; last_name: string; email: string; membership_id: string; attended_sessions: number; no_show_count: number; preferred_days: string; active: number }[];
  const header = 'first_name,last_name,email,membership_id,attended_sessions,no_show_count,preferred_days,active';
  const rows = students.map(s => [s.first_name, s.last_name, s.email, s.membership_id, s.attended_sessions, s.no_show_count, s.preferred_days, s.active].map(escapeCsvField).join(','));
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
  res.send(csv);
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
      const preferred_days = preferredDaysIdx !== -1 ? (fields[preferredDaysIdx]?.trim() || '') : '';
      const active = activeIdx !== -1 ? parseInt(fields[activeIdx]?.trim(), 10) : undefined;

      if (!first_name || !last_name || !email) {
        errors.push(`Row ${i + 1}: missing required fields`);
        skipped++;
        continue;
      }

      try {
        const existing = db.prepare('SELECT id FROM students WHERE email = ? AND deleted_at IS NULL').get(email) as { id: number } | undefined;
        if (existing) {
          db.prepare(`UPDATE students SET first_name = ?, last_name = ?, membership_id = ?${
            attended_sessions != null && !isNaN(attended_sessions) ? ', attended_sessions = ?' : ''
          }${no_show_count != null && !isNaN(no_show_count) ? ', no_show_count = ?' : ''
          }${preferred_days ? ', preferred_days = ?' : ''
          }${active != null && !isNaN(active) ? ', active = ?' : ''
          } WHERE id = ?`).run(
            first_name, last_name, membership_id,
            ...(attended_sessions != null && !isNaN(attended_sessions) ? [attended_sessions] : []),
            ...(no_show_count != null && !isNaN(no_show_count) ? [no_show_count] : []),
            ...(preferred_days ? [preferred_days] : []),
            ...(active != null && !isNaN(active) ? [active] : []),
            existing.id
          );
          if (defaultGroup) {
            const hasGroup = db.prepare('SELECT 1 FROM student_groups WHERE student_id = ?').get(existing.id);
            if (!hasGroup) {
              db.prepare("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))").run(existing.id, defaultGroup.id);
            }
          }
        } else {
          const result = db.prepare(`INSERT INTO students (first_name, last_name, email, membership_id${
            attended_sessions != null && !isNaN(attended_sessions) ? ', attended_sessions' : ''
          }${no_show_count != null && !isNaN(no_show_count) ? ', no_show_count' : ''
          }${preferred_days ? ', preferred_days' : ''
          }${active != null && !isNaN(active) ? ', active' : ''
          }) VALUES (?, ?, ?, ?${
            attended_sessions != null && !isNaN(attended_sessions) ? ', ?' : ''
          }${no_show_count != null && !isNaN(no_show_count) ? ', ?' : ''
          }${preferred_days ? ', ?' : ''
          }${active != null && !isNaN(active) ? ', ?' : ''
          })`).run(
            first_name, last_name, email, membership_id,
            ...(attended_sessions != null && !isNaN(attended_sessions) ? [attended_sessions] : []),
            ...(no_show_count != null && !isNaN(no_show_count) ? [no_show_count] : []),
            ...(preferred_days ? [preferred_days] : []),
            ...(active != null && !isNaN(active) ? [active] : []),
          );
          if (defaultGroup) {
            db.prepare("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))").run(result.lastInsertRowid, defaultGroup.id);
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
  const student = db.prepare('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }
  res.json(student);
});

// Get accepted/pending invitations for a student
router.get('/:id/invitations', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const invitations = db.prepare(`
    SELECT i.id, i.status, ts.date AS session_date, tsl.start_time
    FROM invitations i
    JOIN training_sessions ts ON ts.id = i.session_id
    JOIN timeslots tsl ON tsl.id = i.timeslot_id
    WHERE i.student_id = ? AND i.status IN ('confirmed', 'invited', 'scheduled')
      AND ts.status != 'completed'
    ORDER BY ts.date ASC, tsl.start_time ASC
  `).all(req.params.id);
  res.json(invitations);
});

// Get full invitation history for a student (all statuses, most recent first)
router.get('/:id/invitation-history', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const history = db.prepare(`
    SELECT i.id, i.status, i.invited_at, i.responded_at,
           ts.date AS session_date, tsl.start_time,
           d.name AS discipline_name,
           g.name AS group_name, g.color AS group_color
    FROM invitations i
    JOIN training_sessions ts ON ts.id = i.session_id
    JOIN timeslots tsl ON tsl.id = i.timeslot_id
    LEFT JOIN disciplines d ON d.id = i.discipline_id
    LEFT JOIN groups g ON g.id = i.group_id
    WHERE i.student_id = ?
    ORDER BY i.invited_at DESC, ts.date DESC, tsl.start_time DESC
  `).all(req.params.id);
  res.json(history);
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
      db.prepare("INSERT OR IGNORE INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))").run(studentId, defaultGroup.id);
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
  const student = db.prepare('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  try {
    const applyUpdate = db.transaction(() => {
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

      if (active === 1 && (student as any).active === 0) {
        db.prepare("UPDATE student_groups SET reactivated_at = datetime('now') WHERE student_id = ?").run(req.params.id);
      }
    });
    applyUpdate();

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

// Delete student (soft-delete)
router.delete('/:id', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as any;
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  // Cancel any active (invited/scheduled) invitations for this student
  const activeInvitations = db.prepare(
    "SELECT id FROM invitations WHERE student_id = ? AND status IN ('invited', 'scheduled')"
  ).all(req.params.id) as Array<{ id: number }>;
  for (const inv of activeInvitations) {
    db.prepare("UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE id = ?").run(inv.id);
  }

  // Soft-delete: mark as deleted and deactivate
  db.prepare("UPDATE students SET deleted_at = datetime('now'), active = 0 WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ===== Preferred Timeslots =====

// Get preferred timeslots for a student (grouped by timetable)
router.get('/:id/preferred-timeslots', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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

  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
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

// Get group for a student
router.get('/:id/groups', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const group = db.prepare(`
    SELECT g.id, g.name, g.is_default FROM groups g
    JOIN student_groups sg ON sg.group_id = g.id
    WHERE sg.student_id = ?
  `).get(req.params.id);
  res.json(group || null);
});

// Set group for a student (replaces existing group)
router.put('/:id/groups', (req: Request, res: Response) => {
  const { group_id } = req.body;

  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const setGroup = db.transaction(() => {
    db.prepare('DELETE FROM student_groups WHERE student_id = ?').run(req.params.id);
    if (group_id) {
      db.prepare("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))").run(req.params.id, group_id);
    }
  });
  setGroup();
  res.json({ success: true });
});

// ===== Cooldowns =====

// Set cooldown for a student (days from now)
router.put('/:id/cooldown', (req: Request, res: Response) => {
  const { days } = req.body;
  if (typeof days !== 'number' || days <= 0) { res.status(400).json({ error: 'A positive number of days is required' }); return; }

  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  const cooldownUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
  db.prepare('UPDATE students SET cooldown_until = ? WHERE id = ?').run(cooldownUntil, req.params.id);

  const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Clear cooldown for a student
router.delete('/:id/cooldown', (req: Request, res: Response) => {
  const student = db.prepare('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  // End the cooldown now rather than erasing it, so its end still counts for the queue position.
  db.prepare("UPDATE students SET cooldown_until = datetime('now') WHERE id = ? AND cooldown_until > datetime('now')").run(req.params.id);

  const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  res.json(updated);
});

export default router;
