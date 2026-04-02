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
  const students = db.prepare('SELECT * FROM students ORDER BY last_name ASC, first_name ASC').all();
  res.json(students);
});

// Export students as CSV
router.get('/export', (_req: Request, res: Response) => {
  const students = db.prepare('SELECT first_name, last_name, email, attended_sessions, no_show_count, active FROM students ORDER BY last_name ASC, first_name ASC').all() as { first_name: string; last_name: string; email: string; attended_sessions: number; no_show_count: number; active: number }[];
  const header = 'first_name,last_name,email,attended_sessions,no_show_count,active';
  const rows = students.map(s => [s.first_name, s.last_name, s.email, s.attended_sessions, s.no_show_count, s.active].map(escapeCsvField).join(','));
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
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      const first_name = fields[firstNameIdx]?.trim();
      const last_name = fields[lastNameIdx]?.trim();
      const email = fields[emailIdx]?.trim();

      if (!first_name || !last_name || !email) {
        errors.push(`Row ${i + 1}: missing required fields`);
        skipped++;
        continue;
      }

      try {
        const existing = db.prepare('SELECT id FROM students WHERE email = ?').get(email) as { id: number } | undefined;
        if (existing) {
          db.prepare('UPDATE students SET first_name = ?, last_name = ? WHERE id = ?').run(first_name, last_name, existing.id);
        } else {
          db.prepare('INSERT INTO students (first_name, last_name, email) VALUES (?, ?, ?)').run(first_name, last_name, email);
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
  const { first_name, last_name, email } = req.body;
  if (!first_name || !last_name || !email) { res.status(400).json({ error: 'First name, last name and email are required' }); return; }

  try {
    const result = db.prepare('INSERT INTO students (first_name, last_name, email) VALUES (?, ?, ?)').run(first_name, last_name, email);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(result.lastInsertRowid);
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
  const { first_name, last_name, email, attended_sessions, active } = req.body;
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }

  try {
    db.prepare(`
      UPDATE students SET
        first_name = COALESCE(?, first_name),
        last_name = COALESCE(?, last_name),
        email = COALESCE(?, email),
        attended_sessions = COALESCE(?, attended_sessions),
        active = COALESCE(?, active)
      WHERE id = ?
    `).run(first_name ?? null, last_name ?? null, email ?? null, attended_sessions ?? null, active ?? null, req.params.id);

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

export default router;
