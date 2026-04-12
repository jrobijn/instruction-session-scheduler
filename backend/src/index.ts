import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { initializeDatabase } from './database.js';
import db from './database.js';
import { initializeMailer } from './email.js';
import studentsRouter from './routes/students.js';
import instructorsRouter from './routes/instructors.js';
import sessionsRouter from './routes/sessions.js';
import timetablesRouter from './routes/timetables.js';
import invitationsRouter, { processExpiredInvitations } from './routes/invitations.js';
import settingsRouter from './routes/settings.js';
import { setCheckIntervalChangedCallback } from './routes/settings.js';
import disciplinesRouter from './routes/disciplines.js';
import groupsRouter from './routes/groups.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json());

// Simple admin auth middleware
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = authHeader.slice(7);
  if (token !== process.env.ADMIN_PASSWORD) {
    res.status(403).json({ error: 'Invalid credentials' });
    return;
  }
  next();
}

// Auth endpoint
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, token: process.env.ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Protected admin routes
app.use('/api/students', requireAdmin, studentsRouter);
app.use('/api/instructors', requireAdmin, instructorsRouter);
app.use('/api/sessions', requireAdmin, sessionsRouter);
app.use('/api/timetables', requireAdmin, timetablesRouter);
app.use('/api/settings', requireAdmin, settingsRouter);
app.use('/api/disciplines', requireAdmin, disciplinesRouter);
app.use('/api/groups', requireAdmin, groupsRouter);

// Public routes
app.use('/api/invitations', invitationsRouter);
app.get('/api/public/disciplines', (_req: Request, res: Response) => {
  const disciplines = db.prepare('SELECT id, name FROM disciplines WHERE active = 1 ORDER BY name ASC').all();
  res.json(disciplines);
});
app.get('/api/public/disciplines/:token', (req: Request, res: Response) => {
  // Get disciplines available to the student based on their group memberships
  const invitation = db.prepare(`
    SELECT inv.student_id FROM invitations inv WHERE inv.token = ?
  `).get(req.params.token) as { student_id: number } | undefined;

  if (!invitation) {
    // Fallback: return all active disciplines
    const disciplines = db.prepare('SELECT id, name FROM disciplines WHERE active = 1 ORDER BY name ASC').all();
    res.json(disciplines);
    return;
  }

  const disciplines = db.prepare(`
    SELECT DISTINCT d.id, d.name FROM disciplines d
    JOIN discipline_groups dg ON dg.discipline_id = d.id
    JOIN student_groups sg ON sg.group_id = dg.group_id
    WHERE d.active = 1 AND sg.student_id = ?
    ORDER BY d.name ASC
  `).all(invitation.student_id);
  res.json(disciplines);
});

// Health check
app.get('/api/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

// Initialize and start
initializeDatabase();
initializeMailer();

// Check for expired invitations on a configurable interval
let expirationTimer: ReturnType<typeof setTimeout> | null = null;

function getCheckIntervalMs(): number {
  try {
    const val = (db.prepare("SELECT value FROM settings WHERE key = 'invitation_check_interval_minutes'").get() as any)?.value;
    const minutes = Number(val || '15');
    return Math.max(1, minutes) * 60 * 1000;
  } catch {
    return 15 * 60 * 1000;
  }
}

export function rescheduleExpirationCheck() {
  if (expirationTimer) clearTimeout(expirationTimer);
  expirationTimer = setTimeout(async () => {
    try {
      const count = await processExpiredInvitations();
      if (count > 0) console.log(`Expired ${count} invitation(s) and invited replacements`);
    } catch (err) {
      console.error('Error processing expired invitations:', err);
    }
    rescheduleExpirationCheck();
  }, getCheckIntervalMs());
}

rescheduleExpirationCheck();
setCheckIntervalChangedCallback(() => rescheduleExpirationCheck());

// Also run once at startup
processExpiredInvitations().catch(err => console.error('Error processing expired invitations at startup:', err));

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
