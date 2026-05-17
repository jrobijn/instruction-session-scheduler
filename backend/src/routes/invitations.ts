import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail, sendConfirmationEmail, sendCancellationEmail, getEmailStrings } from '../email.js';
import {
  scheduleInvitationExpiry, cancelInvitationExpiry,
  getExpiryMinutes, computeExpiresAt, isInvitationLogicallyExpired,
} from '../expiryTimers.js';
import { broadcastSession, broadcast } from '../sseClients.js';

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
export async function findAndInviteReplacement(invitation: any): Promise<{ name: string; email: string } | null> {
  const alreadyInvited = (db.prepare(`
    SELECT student_id FROM invitations WHERE session_id = ?
  `).all(invitation.session_id) as Array<{ student_id: number }>).map(r => r.student_id);

  const sessionInfo = db.prepare(
    'SELECT timetable_id FROM training_sessions WHERE id = ?'
  ).get(invitation.session_id) as { timetable_id: number | null };

  const timetableGroupIds = new Set(
    sessionInfo?.timetable_id
      ? (db.prepare('SELECT group_id FROM timetable_groups WHERE timetable_id = ?')
          .all(sessionInfo.timetable_id) as Array<{ group_id: number }>).map(r => r.group_id)
      : []
  );

  const discGroupIds = new Set(
    (db.prepare('SELECT DISTINCT dg.group_id FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id WHERE d.active = 1')
      .all() as Array<{ group_id: number }>).map(r => r.group_id)
  );

  const nextStudent = db.prepare(`
    SELECT * FROM students
    WHERE active = 1
      AND ('|' || preferred_days || '|') LIKE '%|' || ? || '|%'
      AND (cooldown_until IS NULL OR cooldown_until <= ?)
      AND id NOT IN (${alreadyInvited.map(() => '?').join(',')})
      AND id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_sessions ts ON ts.id = inv.session_id
        WHERE ts.date = ? AND inv.status NOT IN ('declined', 'expired', 'cancelled', 'admin_cancelled')
      )
    ORDER BY priority ASC, last_name ASC, first_name ASC
  `).all(String(new Date(invitation.session_date + 'T00:00:00').getDay()), invitation.session_date, ...alreadyInvited, invitation.session_date) as any[];

  // Load preferred timeslots to only invite students who prefer this timeslot
  const prefsByStudent = new Map<number, Set<number>>();
  if (sessionInfo?.timetable_id) {
    const allPrefs = db.prepare(
      'SELECT student_id, timeslot_id FROM student_preferred_timeslots WHERE timetable_id = ?'
    ).all(sessionInfo.timetable_id) as Array<{ student_id: number; timeslot_id: number }>;
    for (const p of allPrefs) {
      if (!prefsByStudent.has(p.student_id)) prefsByStudent.set(p.student_id, new Set());
      prefsByStudent.get(p.student_id)!.add(p.timeslot_id);
    }
  }

  const originalGroupId = invitation.group_id as number | null;
  let replacementStudent = null;
  let replacementGroupId = originalGroupId;

  // First pass: find a replacement from the same group as the original invitation
  for (const student of nextStudent) {
    const studentPrefs = prefsByStudent.get(student.id);
    if (studentPrefs && studentPrefs.size > 0 && !studentPrefs.has(invitation.timeslot_id)) continue;

    const membership = db.prepare('SELECT group_id FROM student_groups WHERE student_id = ?')
      .get(student.id) as { group_id: number } | undefined;
    const studentGroupId = membership?.group_id ?? null;
    if (!studentGroupId || !timetableGroupIds.has(studentGroupId)) continue;
    if (!discGroupIds.has(studentGroupId)) continue;

    const inSameGroup = originalGroupId ? studentGroupId === originalGroupId : true;
    if (inSameGroup) {
      replacementStudent = student;
      replacementGroupId = studentGroupId;
      break;
    }
  }

  // Second pass: if no same-group replacement found, try any timetable group
  if (!replacementStudent && originalGroupId && timetableGroupIds.size > 0) {
    for (const student of nextStudent) {
      const studentPrefs = prefsByStudent.get(student.id);
      if (studentPrefs && studentPrefs.size > 0 && !studentPrefs.has(invitation.timeslot_id)) continue;

      const membership = db.prepare('SELECT group_id FROM student_groups WHERE student_id = ?')
        .get(student.id) as { group_id: number } | undefined;
      const studentGroupId = membership?.group_id ?? null;
      if (!studentGroupId || !timetableGroupIds.has(studentGroupId)) continue;
      if (!discGroupIds.has(studentGroupId)) continue;

      replacementStudent = student;
      replacementGroupId = studentGroupId;
      break;
    }
  }

  if (!replacementStudent) return null;

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, group_id, token) VALUES (?, ?, ?, ?, ?, ?)')
    .run(invitation.session_id, replacementStudent.id, invitation.timeslot_id, invitation.slot_id, replacementGroupId, token);

  // Increment priority for the replacement student
  db.prepare('UPDATE students SET priority = priority + 1 WHERE id = ?').run(replacementStudent.id);
  normalizePriorities();

  try {
    const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
    const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';

    await sendInvitationEmail({
      to: replacementStudent.email,
      studentName: replacementStudent.first_name + ' ' + replacementStudent.last_name,
      date: invitation.session_date,
      token,
      clubName,
      locale: emailLocale,
    });
    db.prepare("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE token = ?").run(token);

    // Schedule expiry timer for the replacement invitation
    const expiryMinutes = getExpiryMinutes();
    if (expiryMinutes > 0) {
      const newInv = db.prepare("SELECT id, invited_at FROM invitations WHERE token = ?").get(token) as any;
      if (newInv) {
        const expiresAt = computeExpiresAt(newInv.invited_at, expiryMinutes);
        scheduleInvitationExpiry(newInv.id, expiresAt.getTime());
      }
    }
  } catch {
    // Email sending failed, but invitation is still created
  }

  // Broadcast new invitation to session listeners
  const fullInv = db.prepare(`
    SELECT inv.*, inv.no_show, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email, s.membership_id AS student_membership_id, s.attended_sessions,
           d.name AS discipline_name, d.abbreviation AS discipline_abbreviation, ts.start_time AS timeslot_start_time,
           ss.instructor_id AS instructor_id, i.first_name || ' ' || i.last_name AS instructor_name,
           g.name AS group_name, g.color AS group_color
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots ts ON ts.id = inv.timeslot_id
    JOIN session_slots ss ON ss.id = inv.slot_id
    JOIN instructors i ON i.id = ss.instructor_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    LEFT JOIN groups g ON g.id = inv.group_id
    WHERE inv.token = ?
  `).get(token) as any;
  if (fullInv) {
    broadcastSession(invitation.session_id, 'invitation_added', fullInv);
  }

  return { name: replacementStudent.first_name + ' ' + replacementStudent.last_name, email: replacementStudent.email };
}

// Process a single expired invitation (called by expiry timer)
export async function processExpiredInvitation(invitationId: number): Promise<void> {
  const inv = db.prepare(`
    SELECT inv.*, ts.date AS session_date, ts.id AS session_id, ts.status AS session_status
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    WHERE inv.id = ? AND inv.status = 'invited'
  `).get(invitationId) as any;

  if (!inv) return; // Already handled (confirmed, declined, etc.)
  if (inv.session_status === 'completed' || inv.session_status === 'cancelled') return;

  db.prepare("UPDATE invitations SET status = 'expired', responded_at = datetime('now') WHERE id = ?").run(inv.id);
  db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(inv.student_id);
  normalizePriorities();

  // Broadcast expiry to session and invitation listeners
  broadcastSession(inv.session_id, 'invitation_updated', { id: inv.id, status: 'expired' });
  broadcast(`invitation:${inv.token}`, 'invitation_updated', { status: 'expired' });

  await findAndInviteReplacement(inv);
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
  const expiryMinutes = getExpiryMinutes();

  // Compute effective status: treat as expired if logically past expiry time
  let effectiveStatus = invitation.status;
  let expires_at: string | null = null;
  if (invitation.status === 'invited' && expiryMinutes > 0 && invitation.invited_at) {
    if (isInvitationLogicallyExpired(invitation.invited_at, expiryMinutes)) {
      effectiveStatus = 'expired';
    } else {
      expires_at = computeExpiresAt(invitation.invited_at, expiryMinutes).toISOString();
    }
  }

  res.json({
    student_name: invitation.student_name,
    date: invitation.session_date,
    start_time: invitation.timeslot_start_time,
    notes: invitation.session_notes,
    status: effectiveStatus,
    session_status: invitation.session_status,
    discipline_name: invitation.discipline_name || null,
    club_name: clubName,
    locale,
    expires_at,
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

  // Check if logically expired (timer may not have fired yet)
  const expiryMinutes = getExpiryMinutes();
  if (expiryMinutes > 0 && invitation.invited_at && isInvitationLogicallyExpired(invitation.invited_at, expiryMinutes)) {
    res.status(400).json({ error: 'This invitation has expired' });
    return;
  }

  // Validate discipline belongs to the invitation's group
  if (discipline_id && invitation.group_id) {
    const allowed = db.prepare(
      'SELECT 1 FROM discipline_groups WHERE discipline_id = ? AND group_id = ?'
    ).get(discipline_id, invitation.group_id);
    if (!allowed) { res.status(400).json({ error: 'Selected discipline is not available for your group' }); return; }
  }

  db.prepare(`
    UPDATE invitations SET status = 'confirmed', discipline_id = ?, responded_at = datetime('now') WHERE id = ?
  `).run(discipline_id || null, invitation.id);

  // Cancel the expiry timer — invitation is resolved
  cancelInvitationExpiry(invitation.id);

  // Broadcast confirmation to session and invitation listeners
  const updatedInv = db.prepare('SELECT discipline_id FROM invitations WHERE id = ?').get(invitation.id) as any;
  let confirmedDisciplineName: string | null = null;
  let confirmedDisciplineAbbr: string | null = null;
  if (updatedInv?.discipline_id) {
    const d = db.prepare('SELECT name, abbreviation FROM disciplines WHERE id = ?').get(updatedInv.discipline_id) as any;
    if (d) { confirmedDisciplineName = d.name; confirmedDisciplineAbbr = d.abbreviation; }
  }
  broadcastSession(invitation.session_id, 'invitation_updated', {
    id: invitation.id, status: 'confirmed',
    discipline_name: confirmedDisciplineName, discipline_abbreviation: confirmedDisciplineAbbr,
  });
  broadcast(`invitation:${req.params.token}`, 'invitation_updated', { status: 'confirmed' });

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
    SELECT inv.*, ts.status AS session_status, ts.date AS session_date, ts.id AS session_id,
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
  if (invitation.status !== 'confirmed') { res.status(400).json({ error: `Cannot cancel — invitation is ${invitation.status}` }); return; }

  db.prepare(`
    UPDATE invitations SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Broadcast cancellation to session and invitation listeners
  broadcastSession(invitation.session_id, 'invitation_updated', { id: invitation.id, status: 'cancelled' });
  broadcast(`invitation:${req.params.token}`, 'invitation_updated', { status: 'cancelled' });

  // Reverse the priority increase that was applied when this student was invited
  db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(invitation.student_id);
  normalizePriorities();

  // Send cancellation confirmation email
  try {
    const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
    const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';
    let disciplineName: string | null = null;
    if (invitation.discipline_id) {
      const disc = db.prepare('SELECT name FROM disciplines WHERE id = ?').get(invitation.discipline_id) as { name: string } | undefined;
      disciplineName = disc?.name || null;
    }
    await sendCancellationEmail({
      to: invitation.student_email,
      studentName: invitation.student_name,
      date: invitation.session_date,
      startTime: invitation.timeslot_start_time,
      disciplineName,
      clubName,
      subject: getEmailStrings(emailLocale).cancellationSubject(clubName),
      locale: emailLocale,
    });
  } catch (err) {
    console.error('Failed to send cancellation email:', err);
  }

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

  // Check if logically expired (timer may not have fired yet)
  const expiryMinutesDecline = getExpiryMinutes();
  if (expiryMinutesDecline > 0 && invitation.invited_at && isInvitationLogicallyExpired(invitation.invited_at, expiryMinutesDecline)) {
    res.status(400).json({ error: 'This invitation has expired' });
    return;
  }

  db.prepare(`
    UPDATE invitations SET status = 'declined', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Cancel the expiry timer — invitation is resolved
  cancelInvitationExpiry(invitation.id);

  // Broadcast decline to session and invitation listeners
  broadcastSession(invitation.session_id, 'invitation_updated', { id: invitation.id, status: 'declined' });
  broadcast(`invitation:${req.params.token}`, 'invitation_updated', { status: 'declined' });

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

export default router;
