import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
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
const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_PASSWORD || 'change-me';

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Admin auth middleware (reads JWT from cookie)
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.auth_token;
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// Auth endpoint
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout endpoint
app.post('/api/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

// Check auth status
app.get('/api/auth/me', (req: Request, res: Response) => {
  const token = req.cookies?.auth_token;
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true });
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// SSE: real-time session updates (admin, authenticated via cookie)
app.get('/api/sessions/:id/events', (req: Request, res: Response) => {
  const token = req.cookies?.auth_token;
  if (!token) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' }); return;
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
