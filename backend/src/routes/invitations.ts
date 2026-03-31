import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail } from '../email.js';

const router = Router();

// Get invitation details by token (public)
router.get('/:token', (req: Request, res: Response) => {
  const invitation = db.prepare(`
    SELECT inv.*, s.name AS student_name, s.email AS student_email,
           te.date AS evening_date, te.notes AS evening_notes, te.status AS evening_status,
           ts.start_time AS timeslot_start_time
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN training_evenings te ON te.id = inv.evening_id
    JOIN timeslots ts ON ts.id = inv.timeslot_id
    WHERE inv.token = ?
  `).get(req.params.token) as any;

  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }

  const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';

  res.json({
    student_name: invitation.student_name,
    date: invitation.evening_date,
    start_time: invitation.timeslot_start_time,
    notes: invitation.evening_notes,
    status: invitation.status,
    evening_status: invitation.evening_status,
    club_name: clubName,
  });
});

// Confirm attendance (public)
router.post('/:token/confirm', (req: Request, res: Response) => {
  const { discipline_id } = req.body || {};
  const invitation = db.prepare(`
    SELECT inv.*, te.status AS evening_status
    FROM invitations inv
    JOIN training_evenings te ON te.id = inv.evening_id
    WHERE inv.token = ?
  `).get(req.params.token) as any;

  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }
  if (invitation.evening_status === 'completed') { res.status(400).json({ error: 'This evening has already passed' }); return; }
  if (invitation.status !== 'invited') { res.status(400).json({ error: `Invitation already ${invitation.status}` }); return; }

  db.prepare(`
    UPDATE invitations SET status = 'confirmed', discipline_id = ?, responded_at = datetime('now') WHERE id = ?
  `).run(discipline_id || null, invitation.id);

  res.json({ success: true, message: 'Your attendance has been confirmed!' });
});

// Decline attendance (public) — triggers next-in-line invitation
router.post('/:token/decline', async (req: Request, res: Response) => {
  const invitation = db.prepare(`
    SELECT inv.*, te.status AS evening_status, te.date AS evening_date, te.id AS evening_id
    FROM invitations inv
    JOIN training_evenings te ON te.id = inv.evening_id
    WHERE inv.token = ?
  `).get(req.params.token) as any;

  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }
  if (invitation.evening_status === 'completed') { res.status(400).json({ error: 'This evening has already passed' }); return; }
  if (invitation.status !== 'invited') { res.status(400).json({ error: `Invitation already ${invitation.status}` }); return; }

  db.prepare(`
    UPDATE invitations SET status = 'declined', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Find the next eligible student to invite as replacement
  const alreadyInvited = (db.prepare(`
    SELECT student_id FROM invitations WHERE evening_id = ?
  `).all(invitation.evening_id) as Array<{ student_id: number }>).map(r => r.student_id);

  const nextStudent = db.prepare(`
    SELECT * FROM students
    WHERE active = 1
      AND id NOT IN (${alreadyInvited.map(() => '?').join(',')})
      AND id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_evenings te ON te.id = inv.evening_id
        WHERE te.date = ? AND inv.status != 'declined'
      )
    ORDER BY attended_sessions ASC, name ASC
    LIMIT 1
  `).get(...alreadyInvited, invitation.evening_date) as any;

  let replacement: { name: string; email: string } | null = null;
  if (nextStudent) {
    const token = crypto.randomUUID();

    // Assign replacement to the same timeslot as the declined invitation
    db.prepare('INSERT INTO invitations (evening_id, student_id, timeslot_id, token) VALUES (?, ?, ?, ?)')
      .run(invitation.evening_id, nextStudent.id, invitation.timeslot_id, token);

    // Try to send email to replacement
    try {
      const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
      const subject = (db.prepare("SELECT value FROM settings WHERE key = 'invitation_email_subject'").get() as any)?.value
        || 'You are invited to a coaching session!';

      await sendInvitationEmail({
        to: nextStudent.email,
        studentName: nextStudent.name,
        date: invitation.evening_date,
        token,
        clubName,
        subject,
      });
      db.prepare('UPDATE invitations SET email_sent = 1 WHERE token = ?').run(token);
    } catch {
      // Email sending failed, but invitation is still created
    }

    replacement = { name: nextStudent.name, email: nextStudent.email };
  }

  res.json({
    success: true,
    message: 'Your decline has been recorded.',
    replacement,
  });
});

export default router;
