import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './database.js';
import db from './database.js';
import { initializeMailer } from './email.js';
import studentsRouter from './routes/students.js';
import instructorsRouter from './routes/instructors.js';
import sessionsRouter from './routes/sessions.js';
import timetablesRouter from './routes/timetables.js';
import invitationsRouter, { processExpiredInvitation } from './routes/invitations.js';
import settingsRouter from './routes/settings.js';
import { setExpirySettingsChangedCallback } from './routes/settings.js';
import { initExpiryTimers, rehydrateTimers } from './expiryTimers.js';
import { subscribe, broadcast } from './sseClients.js';
import disciplinesRouter from './routes/disciplines.js';
import groupsRouter from './routes/groups.js';
import buddyGroupsRouter from './routes/buddyGroups.js';

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

// SSE: real-time session updates (admin, must be before requireAdmin middleware)
app.get('/api/sessions/:id/events', (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (token !== process.env.ADMIN_PASSWORD) {
    res.status(403).json({ error: 'Invalid credentials' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  subscribe(`session:${req.params.id}`, res);
});

// Protected admin routes
app.use('/api/students', requireAdmin, studentsRouter);
app.use('/api/instructors', requireAdmin, instructorsRouter);
app.use('/api/sessions', requireAdmin, sessionsRouter);
app.use('/api/timetables', requireAdmin, timetablesRouter);
app.use('/api/settings', requireAdmin, settingsRouter);
app.use('/api/disciplines', requireAdmin, disciplinesRouter);
app.use('/api/groups', requireAdmin, groupsRouter);
app.use('/api/buddy-groups', requireAdmin, buddyGroupsRouter);

// Public routes
app.use('/api/invitations', invitationsRouter);
app.get('/api/public/disciplines', (_req: Request, res: Response) => {
  const disciplines = db.prepare('SELECT id, name FROM disciplines WHERE active = 1 ORDER BY name ASC').all();
  res.json(disciplines);
});
app.get('/api/public/disciplines/:token', (req: Request, res: Response) => {
  // Get disciplines available to the student based on the invitation's group
  const invitation = db.prepare(`
    SELECT inv.student_id, inv.group_id FROM invitations inv WHERE inv.token = ?
  `).get(req.params.token) as { student_id: number; group_id: number | null } | undefined;

  if (!invitation) {
    // Fallback: return all active disciplines
    const disciplines = db.prepare('SELECT id, name FROM disciplines WHERE active = 1 ORDER BY name ASC').all();
    res.json(disciplines);
    return;
  }

  if (invitation.group_id) {
    // Auto-scheduled: disciplines linked to the invitation's specific group
    const disciplines = db.prepare(`
      SELECT DISTINCT d.id, d.name FROM disciplines d
      JOIN discipline_groups dg ON dg.discipline_id = d.id
      WHERE d.active = 1 AND dg.group_id = ?
      ORDER BY d.name ASC
    `).all(invitation.group_id);
    res.json(disciplines);
  } else {
    // Manually assigned (no group): disciplines from all student's groups
    const disciplines = db.prepare(`
      SELECT DISTINCT d.id, d.name FROM disciplines d
      JOIN discipline_groups dg ON dg.discipline_id = d.id
      JOIN student_groups sg ON sg.group_id = dg.group_id
      WHERE d.active = 1 AND sg.student_id = ?
      ORDER BY d.name ASC
    `).all(invitation.student_id);
    res.json(disciplines);
  }
});

// SSE: real-time invitation updates (public, keyed by token)
app.get('/api/invitations/:token/events', (req: Request, res: Response) => {
  const invitation = db.prepare(
    'SELECT session_id FROM invitations WHERE token = ?'
  ).get(req.params.token) as { session_id: number } | undefined;
  if (!invitation) { res.status(404).json({ error: 'Not found' }); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  subscribe(`invitation:${req.params.token}`, res);
});

// Health check
app.get('/api/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

// Serve frontend static files in production
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Initialize and start
initializeDatabase();
initializeMailer();

// Initialize per-invitation expiry timers
initExpiryTimers(processExpiredInvitation);
rehydrateTimers();
setExpirySettingsChangedCallback(() => rehydrateTimers());

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
