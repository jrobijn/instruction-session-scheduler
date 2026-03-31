import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initializeDatabase } from './database.js';
import { initializeMailer } from './email.js';
import studentsRouter from './routes/students.js';
import instructorsRouter from './routes/instructors.js';
import eveningsRouter from './routes/evenings.js';
import invitationsRouter from './routes/invitations.js';
import settingsRouter from './routes/settings.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json());

// Simple admin auth middleware
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  if (token !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Invalid credentials' });
  }
  next();
}

// Auth endpoint
app.post('/api/auth/login', (req, res) => {
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
app.use('/api/evenings', requireAdmin, eveningsRouter);
app.use('/api/settings', requireAdmin, settingsRouter);

// Public invitation routes
app.use('/api/invitations', invitationsRouter);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Initialize and start
initializeDatabase();
initializeMailer();

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
