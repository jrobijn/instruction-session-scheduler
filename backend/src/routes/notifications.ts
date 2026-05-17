import { Router, Request, Response } from 'express';
import db from '../database.js';
import { broadcast } from '../sseClients.js';

const router = Router();

// Get notifications with pagination
router.get('/', (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const offset = (page - 1) * limit;

  const total = (db.prepare('SELECT COUNT(*) AS count FROM notifications').get() as { count: number }).count;
  const notifications = db.prepare(
    'SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);

  res.json({ notifications, total, page, limit });
});

// Get unread count
router.get('/unread-count', (_req: Request, res: Response) => {
  const row = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE read = 0').get() as { count: number };
  res.json({ count: row.count });
});

// Mark a notification as read
router.post('/:id/read', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  res.json({ success: true });
});

// Mark all notifications as read
router.post('/read-all', (_req: Request, res: Response) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  res.json({ success: true });
});

export default router;

// Helper: create a notification and broadcast via SSE
export function createNotification(data: {
  type: 'invitation_confirmed' | 'invitation_declined' | 'invitation_expired' | 'invitation_cancelled' | 'session_full' | 'session_no_longer_full';
  invitation_id?: number;
  session_id: number;
  student_name?: string;
  session_date: string;
  timeslot_start_time?: string;
}) {
  const result = db.prepare(`
    INSERT INTO notifications (type, invitation_id, session_id, student_name, session_date, timeslot_start_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.type, data.invitation_id || null, data.session_id, data.student_name || '', data.session_date, data.timeslot_start_time || null);

  const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(result.lastInsertRowid);
  const unreadCount = (db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE read = 0').get() as { count: number }).count;

  // Broadcast to SSE listeners
  broadcast('notifications', 'new_notification', { notification, unread_count: unreadCount });
}
