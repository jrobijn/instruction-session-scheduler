import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail, sendConfirmationEmail, sendCancellationEmail, getEmailStrings } from '../email.js';
import {
  scheduleInvitationExpiry, cancelInvitationExpiry,
  getExpiryMinutes, computeExpiresAt, isInvitationLogicallyExpired,
} from '../expiryTimers.js';
import { broadcastSession, broadcast, broadcastSessionsList } from '../sseClients.js';
import { createNotification } from './notifications.js';
import { weightedPickGroup, QUEUE_JOIN_SQL, QUEUE_COLUMNS_SQL, QUEUE_ORDER_SQL } from '../priority.js';

const router = Router();

// Check if a session has full attendance (all slots × timeslots confirmed)
function checkSessionFullAttendance(sessionId: number): { isFull: boolean; totalSlots: number; confirmedCount: number } {
  const session = db.prepare('SELECT timetable_id FROM training_sessions WHERE id = ?').get(sessionId) as { timetable_id: number | null } | undefined;
  if (!session?.timetable_id) return { isFull: false, totalSlots: 0, confirmedCount: 0 };

  const instructorCount = (db.prepare('SELECT COUNT(*) AS cnt FROM session_slots WHERE session_id = ? AND removed = 0').get(sessionId) as any).cnt;
  const timeslotCount = (db.prepare('SELECT COUNT(*) AS cnt FROM timeslots WHERE timetable_id = ?').get(session.timetable_id) as any).cnt;
  const totalSlots = instructorCount * timeslotCount;
  if (totalSlots === 0) return { isFull: false, totalSlots: 0, confirmedCount: 0 };

  const confirmedCount = (db.prepare("SELECT COUNT(*) AS cnt FROM invitations WHERE session_id = ? AND status = 'confirmed'").get(sessionId) as any).cnt;
  return { isFull: confirmedCount >= totalSlots, totalSlots, confirmedCount };
}

// Shared helper: find and invite a replacement student for a vacated slot
export async function findAndInviteReplacement(invitation: any): Promise<{ name: string; email: string } | null> {
  const alreadyInvited = (db.prepare(`
    SELECT student_id FROM invitations WHERE session_id = ?
  `).all(invitation.session_id) as Array<{ student_id: number }>).map(r => r.student_id);

  const sessionInfo = db.prepare(
    'SELECT timetable_id FROM training_sessions WHERE id = ?'
  ).get(invitation.session_id) as { timetable_id: number | null };

  const timetableGroupRows = sessionInfo?.timetable_id
    ? (db.prepare('SELECT group_id, percentage FROM timetable_groups WHERE timetable_id = ?')
        .all(sessionInfo.timetable_id) as Array<{ group_id: number; percentage: number }>)
    : [];
  const timetableGroupIds = new Set(timetableGroupRows.map(r => r.group_id));
  const percentageByGroup = new Map<number, number>(timetableGroupRows.map(r => [r.group_id, r.percentage]));

  const discGroupIds = new Set(
    (db.prepare('SELECT DISTINCT dg.group_id FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id WHERE d.active = 1')
      .all() as Array<{ group_id: number }>).map(r => r.group_id)
  );

  const nextStudent = db.prepare(`
    SELECT s.*, ${QUEUE_COLUMNS_SQL} FROM students s
    JOIN student_groups sg ON sg.student_id = s.id
    ${QUEUE_JOIN_SQL}
    WHERE s.active = 1
      AND s.deleted_at IS NULL
      AND ('|' || s.preferred_days || '|') LIKE '%|' || ? || '|%'
      AND (s.cooldown_until IS NULL OR date(s.cooldown_until) <= ?)
      AND s.id NOT IN (${alreadyInvited.map(() => '?').join(',')})
      AND s.id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_sessions ts ON ts.id = inv.session_id
        WHERE ts.date = ? AND inv.status NOT IN ('declined', 'expired', 'cancelled', 'admin_cancelled')
      )
    ORDER BY ${QUEUE_ORDER_SQL}, RANDOM()
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
  let sameGroupMatch = false;
  let candidateRank = 0;
  let candidatesConsidered = nextStudent.length;

  // First pass: find a replacement from the same group as the original invitation
  for (const student of nextStudent) {
    const studentPrefs = prefsByStudent.get(student.id);
    if (studentPrefs && studentPrefs.size > 0 && !studentPrefs.has(invitation.timeslot_id)) continue;

    const membership = db.prepare('SELECT group_id FROM student_groups WHERE student_id = ?')
      .get(student.id) as { group_id: number } | undefined;
    const studentGroupId = membership?.group_id ?? null;
    if (!studentGroupId || !timetableGroupIds.has(studentGroupId)) continue;
    if (!discGroupIds.has(studentGroupId)) continue;

    candidateRank++;
    const inSameGroup = originalGroupId ? studentGroupId === originalGroupId : true;
    if (inSameGroup) {
      replacementStudent = student;
      replacementGroupId = studentGroupId;
      sameGroupMatch = true;
      break;
    }
  }

  // Second pass: if no same-group replacement found, try any timetable group. Queues are
  // per group, so bucket eligible candidates by group, pick a group at random weighted by
  // its timetable percentage, then take the first candidate in that group's queue.
  if (!replacementStudent && originalGroupId && timetableGroupIds.size > 0) {
    const candidatesByGroup = new Map<number, any[]>();
    for (const student of nextStudent) {
      const studentPrefs = prefsByStudent.get(student.id);
      if (studentPrefs && studentPrefs.size > 0 && !studentPrefs.has(invitation.timeslot_id)) continue;

      const membership = db.prepare('SELECT group_id FROM student_groups WHERE student_id = ?')
        .get(student.id) as { group_id: number } | undefined;
      const studentGroupId = membership?.group_id ?? null;
      if (!studentGroupId || !timetableGroupIds.has(studentGroupId)) continue;
      if (!discGroupIds.has(studentGroupId)) continue;

      if (!candidatesByGroup.has(studentGroupId)) candidatesByGroup.set(studentGroupId, []);
      candidatesByGroup.get(studentGroupId)!.push(student); // already queue-ordered
    }

    if (candidatesByGroup.size > 0) {
      const pickedGroupId = weightedPickGroup([...candidatesByGroup.keys()], percentageByGroup);
      const queue = candidatesByGroup.get(pickedGroupId)!;
      replacementStudent = queue[0];
      replacementGroupId = pickedGroupId;
      sameGroupMatch = false;
      candidateRank = 1;
      candidatesConsidered = queue.length;
    }
  }

  if (!replacementStudent) return null;

  // Get the replaced student's name for the decision log
  const replacedStudentRow = db.prepare(
    "SELECT first_name || ' ' || last_name AS name FROM students WHERE id = ?"
  ).get(invitation.student_id) as { name: string } | undefined;
  const replacedGroupRow = replacementGroupId
    ? db.prepare('SELECT name, color FROM groups WHERE id = ?').get(replacementGroupId) as { name: string; color: string } | undefined
    : undefined;

  // Get the replacement student's preferred timeslots for the decision log
  const replacementPrefs = prefsByStudent.get(replacementStudent.id);
  let preferredTimeslots: string[] | null = null;
  if (replacementPrefs && replacementPrefs.size > 0 && sessionInfo?.timetable_id) {
    const tslots = db.prepare('SELECT id, start_time FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC')
      .all(sessionInfo.timetable_id) as Array<{ id: number; start_time: string }>;
    preferredTimeslots = tslots.filter(t => replacementPrefs.has(t.id)).map(t => t.start_time);
  }

  const clubDaysStr = (db.prepare("SELECT value FROM settings WHERE key = 'club_days'").get() as any)?.value || '0|1|2|3|4|5|6';
  const clubDaysSet = new Set(clubDaysStr.split('|').map(Number));
  const preferredDaysFiltered = replacementStudent.preferred_days
    ? replacementStudent.preferred_days.split('|').map(Number).filter((d: number) => clubDaysSet.has(d))
    : null;
  const preferredDays = preferredDaysFiltered && preferredDaysFiltered.length < clubDaysSet.size ? preferredDaysFiltered : null;
  const decisionLog = JSON.stringify({
    trigger: 'replacement',
    last_turn_at: replacementStudent.last_turn_at ?? null,
    invite_next: replacementStudent.invite_next_since != null,
    candidate_rank: candidateRank,
    candidates_considered: candidatesConsidered,
    group_name: replacedGroupRow?.name || null,
    group_color: replacedGroupRow?.color || null,
    replaced_student: replacedStudentRow?.name || null,
    replacement_reason: invitation.status || 'vacated',
    same_group_match: sameGroupMatch,
    preferred_timeslots: preferredTimeslots,
    preferred_days: preferredDays,
  });

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, group_id, token, decision_log) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(invitation.session_id, replacementStudent.id, invitation.timeslot_id, invitation.slot_id, replacementGroupId, token, decisionLog);

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
  broadcastSessionsList('session_counts_updated', {
    session_id: invitation.session_id,
    invitation_count: (db.prepare('SELECT COUNT(*) AS c FROM invitations WHERE session_id = ?').get(invitation.session_id) as any).c,
    confirmed_count: (db.prepare("SELECT COUNT(*) AS c FROM invitations WHERE session_id = ? AND status = 'confirmed'").get(invitation.session_id) as any).c,
  });

  return { name: replacementStudent.first_name + ' ' + replacementStudent.last_name, email: replacementStudent.email };
}

// Process a single expired invitation (called by expiry timer)
export async function processExpiredInvitation(invitationId: number): Promise<void> {
  const inv = db.prepare(`
    SELECT inv.*, ts.date AS session_date, ts.id AS session_id, ts.status AS session_status,
           s.first_name || ' ' || s.last_name AS student_name,
           tslot.start_time AS timeslot_start_time
    FROM invitations inv
    JOIN training_sessions ts ON ts.id = inv.session_id
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots tslot ON tslot.id = inv.timeslot_id
    WHERE inv.id = ? AND inv.status = 'invited'
  `).get(invitationId) as any;

  if (!inv) return; // Already handled (confirmed, declined, etc.)
  if (inv.session_status === 'completed' || inv.session_status === 'cancelled') return;

  db.prepare("UPDATE invitations SET status = 'expired', responded_at = datetime('now') WHERE id = ?").run(inv.id);

  // Broadcast expiry to session and invitation listeners
  broadcastSession(inv.session_id, 'invitation_updated', { id: inv.id, status: 'expired' });
  broadcast(`invitation:${inv.token}`, 'invitation_updated', { status: 'expired' });
  broadcastSessionsList('session_counts_updated', {
    session_id: inv.session_id,
    invitation_count: (db.prepare('SELECT COUNT(*) AS c FROM invitations WHERE session_id = ?').get(inv.session_id) as any).c,
    confirmed_count: (db.prepare("SELECT COUNT(*) AS c FROM invitations WHERE session_id = ? AND status = 'confirmed'").get(inv.session_id) as any).c,
  });

  createNotification({
    type: 'invitation_expired',
    invitation_id: inv.id,
    session_id: inv.session_id,
    student_name: inv.student_name,
    session_date: inv.session_date,
    timeslot_start_time: inv.timeslot_start_time,
  });

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
  broadcastSessionsList('session_counts_updated', {
    session_id: invitation.session_id,
    invitation_count: (db.prepare('SELECT COUNT(*) AS c FROM invitations WHERE session_id = ?').get(invitation.session_id) as any).c,
    confirmed_count: (db.prepare("SELECT COUNT(*) AS c FROM invitations WHERE session_id = ? AND status = 'confirmed'").get(invitation.session_id) as any).c,
  });

  createNotification({
    type: 'invitation_confirmed',
    invitation_id: invitation.id,
    session_id: invitation.session_id,
    student_name: invitation.student_name,
    session_date: invitation.session_date,
    timeslot_start_time: invitation.timeslot_start_time,
  });

  // Check if session now has full attendance
  const { isFull } = checkSessionFullAttendance(invitation.session_id);
  if (isFull) {
    createNotification({
      type: 'session_full',
      session_id: invitation.session_id,
      session_date: invitation.session_date,
    });
  }

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

  // Check if session was full before this cancellation
  const wasFull = checkSessionFullAttendance(invitation.session_id).isFull;

  db.prepare(`
    UPDATE invitations SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Broadcast cancellation to session and invitation listeners
  broadcastSession(invitation.session_id, 'invitation_updated', { id: invitation.id, status: 'cancelled' });
  broadcast(`invitation:${req.params.token}`, 'invitation_updated', { status: 'cancelled' });
  broadcastSessionsList('session_counts_updated', {
    session_id: invitation.session_id,
    invitation_count: (db.prepare('SELECT COUNT(*) AS c FROM invitations WHERE session_id = ?').get(invitation.session_id) as any).c,
    confirmed_count: (db.prepare("SELECT COUNT(*) AS c FROM invitations WHERE session_id = ? AND status = 'confirmed'").get(invitation.session_id) as any).c,
  });

  createNotification({
    type: 'invitation_cancelled',
    invitation_id: invitation.id,
    session_id: invitation.session_id,
    student_name: invitation.student_name,
    session_date: invitation.session_date,
    timeslot_start_time: invitation.timeslot_start_time,
  });

  // Check if session lost full attendance
  if (wasFull) {
    createNotification({
      type: 'session_no_longer_full',
      session_id: invitation.session_id,
      session_date: invitation.session_date,
    });
  }

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
  broadcastSessionsList('session_counts_updated', {
    session_id: invitation.session_id,
    invitation_count: (db.prepare('SELECT COUNT(*) AS c FROM invitations WHERE session_id = ?').get(invitation.session_id) as any).c,
    confirmed_count: (db.prepare("SELECT COUNT(*) AS c FROM invitations WHERE session_id = ? AND status = 'confirmed'").get(invitation.session_id) as any).c,
  });

  // Get student name for notification
  const declinedStudent = db.prepare(
    "SELECT first_name || ' ' || last_name AS student_name FROM students WHERE id = ?"
  ).get(invitation.student_id) as { student_name: string } | undefined;
  const declinedSession = db.prepare(
    'SELECT date FROM training_sessions WHERE id = ?'
  ).get(invitation.session_id) as { date: string } | undefined;
  const declinedTimeslot = db.prepare(
    'SELECT start_time FROM timeslots WHERE id = ?'
  ).get(invitation.timeslot_id) as { start_time: string } | undefined;

  createNotification({
    type: 'invitation_declined',
    invitation_id: invitation.id,
    session_id: invitation.session_id,
    student_name: declinedStudent?.student_name || 'Unknown',
    session_date: declinedSession?.date || '',
    timeslot_start_time: declinedTimeslot?.start_time,
  });

  const replacement = await findAndInviteReplacement(invitation);

  res.json({
    success: true,
    message: 'Your decline has been recorded.',
    replacement,
  });
});

export default router;
