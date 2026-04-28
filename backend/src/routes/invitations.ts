import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail, sendConfirmationEmail, getEmailStrings } from '../email.js';

const router = Router();

// Normalize priorities so the minimum active student has priority 1
function normalizePriorities() {
  const minPriority = (db.prepare(
    "SELECT MIN(priority) AS m FROM students WHERE active = 1 AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))"
  ).get() as any)?.m;
  if (minPriority != null && minPriority !== 1) {
    db.prepare('UPDATE students SET priority = priority - ?').run(minPriority - 1);
  }
}

// Shared helper: find and invite a replacement student for a vacated slot
async function findAndInviteReplacement(invitation: any): Promise<{ name: string; email: string } | null> {
  const alreadyInvited = (db.prepare(`
    SELECT student_id FROM invitations WHERE session_id = ?
  `).all(invitation.session_id) as Array<{ student_id: number }>).map(r => r.student_id);

  const sessionInfo = db.prepare(
    'SELECT timetable_id FROM training_sessions WHERE id = ?'
  ).get(invitation.session_id) as { timetable_id: number | null };

  const timetableGroupIds = sessionInfo?.timetable_id
    ? (db.prepare('SELECT group_id FROM timetable_groups WHERE timetable_id = ?')
        .all(sessionInfo.timetable_id) as Array<{ group_id: number }>).map(r => r.group_id)
    : [];

  const discGroupIds = new Set(
    (db.prepare('SELECT DISTINCT dg.group_id FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id WHERE d.active = 1')
      .all() as Array<{ group_id: number }>).map(r => r.group_id)
  );

  const nextStudent = db.prepare(`
    SELECT * FROM students
    WHERE active = 1
      AND ('|' || preferred_days || '|') LIKE '%|' || ? || '|%'
      AND (cooldown_until IS NULL OR cooldown_until <= datetime('now'))
      AND id NOT IN (${alreadyInvited.map(() => '?').join(',')})
      AND id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_sessions ts ON ts.id = inv.session_id
        WHERE ts.date = ? AND inv.status NOT IN ('declined', 'expired', 'cancelled')
      )
    ORDER BY priority ASC, last_name ASC, first_name ASC
  `).all(String(new Date(invitation.session_date + 'T00:00:00').getDay()), ...alreadyInvited, invitation.session_date) as any[];

  const originalGroupId = invitation.group_id as number | null;
  let replacementStudent = null;
  for (const student of nextStudent) {
    const studentGroupIds = (db.prepare('SELECT group_id FROM student_groups WHERE student_id = ?')
      .all(student.id) as Array<{ group_id: number }>).map(r => r.group_id);
    const inSameGroup = originalGroupId
      ? studentGroupIds.includes(originalGroupId)
      : (timetableGroupIds.length === 0 || studentGroupIds.some(gid => timetableGroupIds.includes(gid)));
    const hasDisciplines = studentGroupIds.some(gid => discGroupIds.has(gid));
    if (inSameGroup && hasDisciplines) {
      replacementStudent = student;
      break;
    }
  }

  if (!replacementStudent) return null;

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO invitations (session_id, student_id, timeslot_id, instructor_id, group_id, token) VALUES (?, ?, ?, ?, ?, ?)')
    .run(invitation.session_id, replacementStudent.id, invitation.timeslot_id, invitation.instructor_id, originalGroupId, token);

  // Increment priority for the replacement student
  db.prepare('UPDATE students SET priority = priority + 1 WHERE id = ?').run(replacementStudent.id);
  normalizePriorities();

  try {
    const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
    const subject = (db.prepare("SELECT value FROM settings WHERE key = 'invitation_email_subject'").get() as any)?.value
      || 'You are invited to a coaching session!';
    const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';

    await sendInvitationEmail({
      to: replacementStudent.email,
      studentName: replacementStudent.first_name + ' ' + replacementStudent.last_name,
      date: invitation.session_date,
      token,
      clubName,
      subject,
      locale: emailLocale,
    });
    db.prepare("UPDATE invitations SET email_sent = 1, status = 'invited' WHERE token = ?").run(token);
  } catch {
    // Email sending failed, but invitation is still created
  }

  return { name: replacementStudent.first_name + ' ' + replacementStudent.last_name, email: replacementStudent.email };
}

// Get invitation details by token (public)
router.get('/:token', (req: Request, res: Response) => {
  const invitation = db.prepare(`
    SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
           ts.date AS session_date, ts.notes AS session_notes, ts.status AS session_status,
           tslot.start_time AS timeslot_start_time,
           d.name AS discipline_name
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN training_sessions ts ON ts.id = inv.session_id
    JOIN timeslots tslot ON tslot.id = inv.timeslot_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    WHERE inv.token = ?
  `).get(req.params.token) as any;

  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }

  const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
  const locale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';

  res.json({
    student_name: invitation.student_name,
    date: invitation.session_date,
    start_time: invitation.timeslot_start_time,
    notes: invitation.session_notes,
    status: invitation.status,
    session_status: invitation.session_status,
    discipline_name: invitation.discipline_name || null,
    club_name: clubName,
    locale,
  });
});

// Confirm attendance (public)
router.post('/:token/confirm', async (req: Request, res: Response) => {
  const { discipline_id } = req.body || {};
  const invitation = db.prepare(`
    SELECT inv.*, ts.status AS session_status, ts.date AS session_date,
           s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
           tslot.start_time AS timeslot_start_time
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots tslot ON tslot.id = inv.timeslot_id
    WHERE inv.token = ?
  `).get(req.params.token) as any;

  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }
  if (invitation.session_status === 'completed') { res.status(400).json({ error: 'This session has already passed' }); return; }
  if (invitation.status !== 'invited') { res.status(400).json({ error: `Invitation already ${invitation.status}` }); return; }

  db.prepare(`
    UPDATE invitations SET status = 'confirmed', discipline_id = ?, responded_at = datetime('now') WHERE id = ?
  `).run(discipline_id || null, invitation.id);

  // Send confirmation email with cancellation link
  try {
    const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
    const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';
    let disciplineName: string | null = null;
    if (discipline_id) {
      const disc = db.prepare('SELECT name FROM disciplines WHERE id = ?').get(discipline_id) as { name: string } | undefined;
      disciplineName = disc?.name || null;
    }
    await sendConfirmationEmail({
      to: invitation.student_email,
      studentName: invitation.student_name,
      date: invitation.session_date,
      startTime: invitation.timeslot_start_time,
      disciplineName,
      token: req.params.token as string,
      clubName,
      subject: getEmailStrings(emailLocale).confirmationSubject(clubName),
      locale: emailLocale,
    });
  } catch (err) {
    console.error('Failed to send confirmation email:', err);
  }

  res.json({ success: true, message: 'Your attendance has been confirmed!' });
});

// Cancel confirmed attendance (public) — triggers next-in-line invitation
router.post('/:token/cancel', async (req: Request, res: Response) => {
  const invitation = db.prepare(`
    SELECT inv.*, ts.status AS session_status, ts.date AS session_date, ts.id AS session_id
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    WHERE inv.token = ?
  `).get(req.params.token) as any;

  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }
  if (invitation.session_status === 'completed') { res.status(400).json({ error: 'This session has already passed' }); return; }
  if (invitation.status !== 'confirmed') { res.status(400).json({ error: `Cannot cancel — invitation is ${invitation.status}` }); return; }

  db.prepare(`
    UPDATE invitations SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Reverse the priority increase that was applied when this student was invited
  db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(invitation.student_id);
  normalizePriorities();

  const replacement = await findAndInviteReplacement(invitation);

  res.json({
    success: true,
    message: 'Your participation has been cancelled.',
    replacement,
  });
});

// Decline attendance (public) — triggers next-in-line invitation
router.post('/:token/decline', async (req: Request, res: Response) => {
  const invitation = db.prepare(`
    SELECT inv.*, ts.status AS session_status, ts.date AS session_date, ts.id AS session_id
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    WHERE inv.token = ?
  `).get(req.params.token) as any;

  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }
  if (invitation.session_status === 'completed') { res.status(400).json({ error: 'This session has already passed' }); return; }
  if (invitation.status !== 'invited') { res.status(400).json({ error: `Invitation already ${invitation.status}` }); return; }

  db.prepare(`
    UPDATE invitations SET status = 'declined', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Reverse the priority increase that was applied when this student was invited
  db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(invitation.student_id);
  normalizePriorities();

  const replacement = await findAndInviteReplacement(invitation);

  res.json({
    success: true,
    message: 'Your decline has been recorded.',
    replacement,
  });
});

// Process expired invitations: mark as expired and invite replacements
export async function processExpiredInvitations(): Promise<number> {
  const expiryMinutes = Number(
    (db.prepare("SELECT value FROM settings WHERE key = 'invitation_expiry_minutes'").get() as any)?.value || '120'
  );
  if (expiryMinutes <= 0) return 0; // 0 means no expiration

  // Find invited (not yet responded) invitations older than the expiry window
  // for sessions that haven't been completed yet
  const expired = db.prepare(`
    SELECT inv.*, ts.date AS session_date, ts.id AS session_id
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    WHERE inv.status = 'invited'
      AND ts.status != 'completed'
      AND datetime(inv.invited_at, '+' || ? || ' minutes') < datetime('now')
  `).all(expiryMinutes) as any[];

  for (const inv of expired) {
    db.prepare("UPDATE invitations SET status = 'expired', responded_at = datetime('now') WHERE id = ?").run(inv.id);
    // Reverse the priority increase that was applied when this student was invited
    db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(inv.student_id);
    normalizePriorities();
    await findAndInviteReplacement(inv);
  }

  return expired.length;
}

export default router;
