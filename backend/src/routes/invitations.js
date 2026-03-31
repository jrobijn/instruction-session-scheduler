import { Router } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail } from '../email.js';

const router = Router();

// Get invitation details by token (public)
router.get('/:token', (req, res) => {
  const invitation = db.prepare(`
    SELECT inv.*, s.name AS student_name, s.email AS student_email,
           te.date AS evening_date, te.notes AS evening_notes, te.status AS evening_status
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN training_evenings te ON te.id = inv.evening_id
    WHERE inv.token = ?
  `).get(req.params.token);

  if (!invitation) return res.status(404).json({ error: 'Invitation not found' });

  const clubName = db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get()?.value || 'Sports Club';

  res.json({
    student_name: invitation.student_name,
    date: invitation.evening_date,
    notes: invitation.evening_notes,
    status: invitation.status,
    evening_status: invitation.evening_status,
    club_name: clubName,
  });
});

// Confirm attendance (public)
router.post('/:token/confirm', (req, res) => {
  const { discipline_id } = req.body || {};
  const invitation = db.prepare(`
    SELECT inv.*, te.status AS evening_status
    FROM invitations inv
    JOIN training_evenings te ON te.id = inv.evening_id
    WHERE inv.token = ?
  `).get(req.params.token);

  if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
  if (invitation.evening_status === 'completed') return res.status(400).json({ error: 'This evening has already passed' });
  if (invitation.status !== 'invited') return res.status(400).json({ error: `Invitation already ${invitation.status}` });

  db.prepare(`
    UPDATE invitations SET status = 'confirmed', discipline_id = ?, responded_at = datetime('now') WHERE id = ?
  `).run(discipline_id || null, invitation.id);

  res.json({ success: true, message: 'Your attendance has been confirmed!' });
});

// Decline attendance (public) — triggers next-in-line invitation
router.post('/:token/decline', async (req, res) => {
  const invitation = db.prepare(`
    SELECT inv.*, te.status AS evening_status, te.date AS evening_date, te.id AS evening_id
    FROM invitations inv
    JOIN training_evenings te ON te.id = inv.evening_id
    WHERE inv.token = ?
  `).get(req.params.token);

  if (!invitation) return res.status(404).json({ error: 'Invitation not found' });
  if (invitation.evening_status === 'completed') return res.status(400).json({ error: 'This evening has already passed' });
  if (invitation.status !== 'invited') return res.status(400).json({ error: `Invitation already ${invitation.status}` });

  db.prepare(`
    UPDATE invitations SET status = 'declined', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Find the next eligible student to invite as replacement
  const alreadyInvited = db.prepare(`
    SELECT student_id FROM invitations WHERE evening_id = ?
  `).all(invitation.evening_id).map(r => r.student_id);

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
  `).get(...alreadyInvited, invitation.evening_date);

  let replacement = null;
  if (nextStudent) {
    const token = crypto.randomUUID();
    const maxSlot = db.prepare('SELECT MAX(slot_number) AS max_slot FROM invitations WHERE evening_id = ?')
      .get(invitation.evening_id).max_slot || 0;

    db.prepare('INSERT INTO invitations (evening_id, student_id, token, slot_number) VALUES (?, ?, ?, ?)')
      .run(invitation.evening_id, nextStudent.id, token, maxSlot + 1);

    // Try to send email to replacement
    try {
      const clubName = db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get()?.value || 'Sports Club';
      const subject = db.prepare("SELECT value FROM settings WHERE key = 'invitation_email_subject'").get()?.value
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
