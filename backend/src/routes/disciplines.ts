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

// List all disciplines
router.get('/', (_req: Request, res: Response) => {
  const disciplines = db.prepare('SELECT * FROM disciplines ORDER BY name ASC').all();
  res.json(disciplines);
});

// Export disciplines as CSV
router.get('/export', (_req: Request, res: Response) => {
  const disciplines = db.prepare('SELECT name, active FROM disciplines ORDER BY name ASC').all() as { name: string; active: number }[];
  const header = 'name,active';
  const rows = disciplines.map(d => [d.name, d.active].map(escapeCsvField).join(','));
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="disciplines.csv"');
  res.send(csv);
});

// Import disciplines from CSV
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
        const existing = db.prepare('SELECT id FROM disciplines WHERE name = ?').get(name) as { id: number } | undefined;
        if (existing) {
          skipped++;
        } else {
          db.prepare('INSERT INTO disciplines (name) VALUES (?)').run(name);
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
