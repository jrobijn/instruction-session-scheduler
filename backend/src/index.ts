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
import invitationsRouter from './routes/invitations.js';
import settingsRouter from './routes/settings.js';
import disciplinesRouter from './routes/disciplines.js';

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

// Public routes
app.use('/api/invitations', invitationsRouter);
app.get('/api/public/disciplines', (_req: Request, res: Response) => {
  const disciplines = db.prepare('SELECT id, name FROM disciplines WHERE active = 1 ORDER BY name ASC').all();
  res.json(disciplines);
});

// Health check
app.get('/api/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

// Initialize and start
initializeDatabase();
initializeMailer();

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
