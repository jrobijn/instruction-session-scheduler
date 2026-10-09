import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail, sendAdminCancellationEmail, getEmailStrings } from '../email.js';
import {
  scheduleExpiryForInvitation, cancelInvitationExpiry, cancelAllSessionTimers,
  getExpiryMinutes, getEffectiveStatus, getExpiresAtIso,
} from '../expiryTimers.js';
import { broadcastSession, broadcast, broadcastSessionsList } from '../sseClients.js';
import { findAndInviteReplacement } from './invitations.js';
import { weightedPickGroup, QUEUE_JOIN_SQL, QUEUE_COLUMNS_SQL, QUEUE_ORDER_SQL } from '../priority.js';

const router = Router();

function broadcastSessionCounts(sessionId: number) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM invitations WHERE session_id = ?) AS invitation_count,
      (SELECT COUNT(*) FROM invitations WHERE session_id = ? AND status = 'confirmed') AS confirmed_count
  `).get(sessionId, sessionId) as { invitation_count: number; confirmed_count: number } | undefined;
  if (row) {
    broadcastSessionsList('session_counts_updated', { session_id: sessionId, ...row });
  }
}

// List all training sessions
router.get('/', (_req: Request, res: Response) => {
  const sessions = db.prepare(`
    SELECT ts.*,
      (SELECT COUNT(*) FROM session_slots WHERE session_id = ts.id AND removed = 0) AS instructor_count,
      (SELECT COUNT(*) FROM invitations WHERE session_id = ts.id) AS invitation_count,
      (SELECT COUNT(*) FROM invitations WHERE session_id = ts.id AND status = 'confirmed') AS confirmed_count,
      (SELECT COUNT(*) FROM session_slots WHERE session_id = ts.id AND removed = 0) *
        (SELECT COUNT(*) FROM timeslots WHERE timetable_id = ts.timetable_id) AS total_slots,
      tt.name AS timetable_name
    FROM training_sessions ts
    LEFT JOIN timetables tt ON tt.id = ts.timetable_id
    ORDER BY ts.date DESC
  `).all();
  res.json(sessions);
});

// Get single training session with details
router.get('/:id', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  const instructors = db.prepare(`
    SELECT i.* FROM instructors i
    JOIN session_slots si ON si.instructor_id = i.id
    WHERE si.session_id = ? AND si.removed = 0
    ORDER BY i.last_name ASC, i.first_name ASC
  `).all(req.params.id);

  // Get timeslots from the attached timetable
  let timeslots: any[] = [];
  let timetable = null;
  let timetableGroups: any[] = [];
  if (session.timetable_id) {
    timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(session.timetable_id);
    timeslots = db.prepare('SELECT * FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC').all(session.timetable_id);
    timetableGroups = db.prepare(`
      SELECT tg.group_id, tg.percentage, g.name AS group_name, g.color AS group_color, g.is_default
      FROM timetable_groups tg
      JOIN groups g ON g.id = tg.group_id
      WHERE tg.timetable_id = ?
      ORDER BY tg.position ASC
    `).all(session.timetable_id);
  }

  const invitations = db.prepare(`
    SELECT inv.*, inv.no_show, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email, s.membership_id AS student_membership_id, s.attended_sessions,
           d.name AS discipline_name, d.abbreviation AS discipline_abbreviation, ts.start_time AS timeslot_start_time,
           ss.instructor_id AS instructor_id, i.first_name || ' ' || i.last_name AS instructor_name,
           g.name AS group_name, g.color AS group_color,
           bgm.buddy_group_id AS buddy_group_id
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots ts ON ts.id = inv.timeslot_id
    JOIN session_slots ss ON ss.id = inv.slot_id
    JOIN instructors i ON i.id = ss.instructor_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    LEFT JOIN groups g ON g.id = inv.group_id
    LEFT JOIN buddy_group_members bgm ON bgm.student_id = inv.student_id
    WHERE inv.session_id = ?
    ORDER BY ts.start_time ASC, i.last_name ASC, i.first_name ASC, inv.id ASC
  `).all(req.params.id) as any[];

  // Compute buddy group names from member first names
  const buddyGroupIds = [...new Set(invitations.map(inv => inv.buddy_group_id).filter(Boolean))];
  const buddyNameMap = new Map<number, string>();
  for (const bgId of buddyGroupIds) {
    const members = db.prepare(
      `SELECT s.first_name FROM students s JOIN buddy_group_members bgm ON bgm.student_id = s.id WHERE bgm.buddy_group_id = ? AND s.deleted_at IS NULL`
    ).all(bgId) as { first_name: string }[];
    buddyNameMap.set(bgId, members.map(m => m.first_name).join(' & '));
  }
  const invitationsWithBuddyName = invitations.map(inv => ({
    ...inv,
    buddy_group_name: inv.buddy_group_id ? buddyNameMap.get(inv.buddy_group_id) || null : null,
  }));

  const expiryMinutes = getExpiryMinutes();

  const effectiveInvitations = invitationsWithBuddyName.map(inv => {
    const timing = { ...inv, session_date: session.date };
    return { ...inv, status: getEffectiveStatus(timing, expiryMinutes), expires_at: getExpiresAtIso(timing, expiryMinutes) };
  });

  res.json({ ...session, instructors, timeslots, invitations: effectiveInvitations, timetable, timetableGroups, invitation_expiry_minutes: expiryMinutes });
});

// Create training session
router.post('/', (req: Request, res: Response) => {
  const { date, notes, timetable_id } = req.body;
  if (!date) { res.status(400).json({ error: 'Date is required' }); return; }

  // Use provided timetable_id or fall back to the default timetable
  let ttId = timetable_id;
  if (!ttId) {
    const defaultTt = db.prepare("SELECT id FROM timetables WHERE is_default = 1 AND active = 1 AND status = 'saved'").get() as any;
    ttId = defaultTt?.id || null;
  }

  try {
    const dayOfWeek = new Date(date + 'T00:00:00').getDay();
    const result = db.prepare('INSERT INTO training_sessions (date, day_of_week, notes, timetable_id) VALUES (?, ?, ?, ?)').run(date, dayOfWeek, notes || null, ttId);
    const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(session);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A training session already exists for this date' });
      return;
    }
    throw err;
  }
});

// Update training session
router.put('/:id', (req: Request, res: Response) => {
  const { date, notes, status, timetable_id } = req.body;
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  // Handle timetable change
  if (timetable_id !== undefined && timetable_id !== session.timetable_id) {
    if (session.status === 'invitations_sent' || session.status === 'completed') {
      res.status(400).json({ error: 'Cannot change timetable after invitations have been sent' });
      return;
    }
    if (session.status === 'scheduled') {
      // Clear schedule and reset to draft
      db.prepare('DELETE FROM invitations WHERE session_id = ?').run(req.params.id);
      db.prepare("UPDATE training_sessions SET status = 'draft' WHERE id = ?").run(req.params.id);
    }
  }

  db.prepare(`
    UPDATE training_sessions SET
      date = COALESCE(?, date),
      notes = COALESCE(?, notes),
      status = COALESCE(?, status),
      timetable_id = COALESCE(?, timetable_id)
    WHERE id = ?
  `).run(date ?? null, notes ?? null, status ?? null, timetable_id ?? null, req.params.id);

  const updated = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete training session
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM training_sessions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Training session not found' }); return; }
  res.json({ success: true });
});

// ===== Instructor Assignment =====

// Assign instructor to session
router.post('/:id/instructors', (req: Request, res: Response) => {
  const { instructor_id } = req.body;
  if (!instructor_id) { res.status(400).json({ error: 'instructor_id is required' }); return; }

  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  // Check if there's a removed slot for this instructor (re-assign case)
  const removedSlot = db.prepare('SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 1')
    .get(req.params.id, instructor_id) as { id: number } | undefined;
  if (removedSlot) {
    db.prepare('UPDATE session_slots SET removed = 0 WHERE id = ?').run(removedSlot.id);
    res.status(201).json({ success: true });
    return;
  }

  try {
    db.prepare('INSERT INTO session_slots (session_id, instructor_id) VALUES (?, ?)').run(req.params.id, instructor_id);
    res.status(201).json({ success: true });
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Instructor already assigned to this session' });
      return;
    }
    if (err.message.includes('FOREIGN KEY')) {
      res.status(400).json({ error: 'Invalid instructor' });
      return;
    }
    throw err;
  }
});

// Remove instructor from session
router.delete('/:id/instructors/:instructorId', async (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status === 'completed') { res.status(400).json({ error: 'Cannot modify a completed session' }); return; }

  const assignment = db.prepare('SELECT * FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0')
    .get(req.params.id, req.params.instructorId) as any;
  if (!assignment) { res.status(404).json({ error: 'Assignment not found' }); return; }

  // Find all invitations for this instructor's slot in this session
  const affectedInvitations = db.prepare(`
    SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
           tslot.start_time AS timeslot_start_time, d.name AS discipline_name
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots tslot ON tslot.id = inv.timeslot_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    WHERE inv.slot_id = ?
  `).all(assignment.id) as any[];

  const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
  const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';

  for (const inv of affectedInvitations) {
    if (inv.status === 'invited' || inv.status === 'confirmed') {
      // Admin-cancel active invitations and notify
      db.prepare("UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE id = ?").run(inv.id);
      cancelInvitationExpiry(inv.id);
      broadcast(`invitation:${inv.token}`, 'invitation_updated', { status: 'admin_cancelled' });
      if (inv.email_sent) {
        try {
          await sendAdminCancellationEmail({
            to: inv.student_email,
            studentName: inv.student_name,
            date: session.date,
            startTime: inv.timeslot_start_time,
            disciplineName: inv.discipline_name || null,
            clubName,
            locale: emailLocale,
          });
        } catch (err) {
          console.error('Failed to send admin cancellation email:', err);
        }
      }
    } else if (inv.status === 'scheduled') {
      // Pre-send: just delete
      db.prepare('DELETE FROM invitations WHERE id = ?').run(inv.id);
    }
    // declined/expired/invalidated/cancelled/admin_cancelled: leave as-is
  }

  // Mark the instructor slot as removed (invitations remain linked for history)
  db.prepare('UPDATE session_slots SET removed = 1 WHERE id = ?').run(assignment.id);

  res.json({ success: true, cancelled: affectedInvitations.filter(i => i.status === 'invited' || i.status === 'confirmed').length });

  // Broadcast structural change
  broadcastSession(Number(req.params.id), 'reload', {});
});

// Replace instructor: reassign all active invitations to a new instructor
router.post('/:id/instructors/:instructorId/replace', (req: Request, res: Response) => {
  const { new_instructor_id } = req.body;
  if (!new_instructor_id) { res.status(400).json({ error: 'new_instructor_id is required' }); return; }

  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status === 'completed') { res.status(400).json({ error: 'Cannot modify a completed session' }); return; }

  const oldInstructorId = Number(req.params.instructorId);
  const newInstructorId = Number(new_instructor_id);
  if (oldInstructorId === newInstructorId) { res.status(400).json({ error: 'New instructor must be different' }); return; }

  // Verify old instructor is assigned
  const oldAssignment = db.prepare('SELECT * FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0')
    .get(req.params.id, oldInstructorId) as any;
  if (!oldAssignment) { res.status(404).json({ error: 'Original instructor not assigned to this session' }); return; }

  // Verify new instructor exists
  const newInstructor = db.prepare('SELECT * FROM instructors WHERE id = ? AND deleted_at IS NULL').get(newInstructorId) as any;
  if (!newInstructor) { res.status(400).json({ error: 'New instructor not found' }); return; }

  // Verify new instructor is not already actively assigned
  const existingAssignment = db.prepare('SELECT * FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0')
    .get(req.params.id, newInstructorId) as any;
  if (existingAssignment) { res.status(409).json({ error: 'New instructor is already assigned to this session' }); return; }

  // If the new instructor has a removed slot, move its invitations to the old slot then delete it
  const removedSlot = db.prepare('SELECT * FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 1')
    .get(req.params.id, newInstructorId) as any;
  if (removedSlot) {
    db.prepare('UPDATE invitations SET slot_id = ? WHERE slot_id = ?').run(oldAssignment.id, removedSlot.id);
    db.prepare('DELETE FROM session_slots WHERE id = ?').run(removedSlot.id);
  }

  // Update the slot's instructor — all invitations automatically point to the new instructor
  db.prepare('UPDATE session_slots SET instructor_id = ? WHERE id = ?')
    .run(newInstructorId, oldAssignment.id);

  res.json({ success: true });

  // Broadcast structural change
  broadcastSession(Number(req.params.id), 'reload', {});
});

// ===== Schedule Generation =====

// Generate schedule for a session: group-based allocation with preferred timeslots
router.post('/:id/generate-schedule', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  if (!session.timetable_id) { res.status(400).json({ error: 'No timetable attached to this session' }); return; }

  const instructorCount = (db.prepare('SELECT COUNT(*) AS cnt FROM session_slots WHERE session_id = ? AND removed = 0')
    .get(req.params.id) as any).cnt;
  if (instructorCount === 0) { res.status(400).json({ error: 'No instructors assigned for this session' }); return; }

  // Use timeslots from the attached timetable
  const timeslots = db.prepare('SELECT * FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC')
    .all(session.timetable_id) as any[];
  if (timeslots.length === 0) { res.status(400).json({ error: 'No timeslots defined in the attached timetable' }); return; }

  // Each timeslot has one spot per instructor
  const totalSlots = timeslots.length * instructorCount;

  // Keep manually-added invitations (group_id IS NULL), only remove auto-generated ones
  const manualInvitations = db.prepare(
    'SELECT * FROM invitations WHERE session_id = ? AND group_id IS NULL'
  ).all(req.params.id) as any[];

  db.prepare('DELETE FROM invitations WHERE session_id = ? AND group_id IS NOT NULL').run(req.params.id);

  const availableSlots = totalSlots - manualInvitations.length;

  // Get groups assigned to this timetable with percentages (in timetable definition order)
  const timetableGroups = db.prepare(`
    SELECT tg.group_id, tg.percentage, g.name AS group_name, g.color AS group_color
    FROM timetable_groups tg
    JOIN groups g ON g.id = tg.group_id
    WHERE tg.timetable_id = ?
    ORDER BY tg.position ASC
  `).all(session.timetable_id) as Array<{ group_id: number; percentage: number; group_name: string; group_color: string }>;

  if (timetableGroups.length === 0) {
    res.status(400).json({ error: 'No groups assigned to this timetable' }); return;
  }

  // Compute slots per group from percentages based on remaining available slots
  const groupSlotCounts: Array<{ group_id: number; slots: number }> = [];
  let allocated = 0;
  for (const tg of timetableGroups) {
    const slots = Math.floor(availableSlots * tg.percentage / 100);
    groupSlotCounts.push({ group_id: tg.group_id, slots });
    allocated += slots;
  }
  // Distribute remainder round-robin across groups
  let remainder = availableSlots - allocated;
  for (const gsc of groupSlotCounts) {
    if (remainder <= 0) break;
    gsc.slots++;
    remainder--;
  }

  // Students in a timetable group with at least one active discipline (needed to confirm), in queue order
  const sessionDow = String(new Date(session.date + 'T00:00:00').getDay());
  const allEligibleStudents = db.prepare(`
    SELECT s.*, sg.group_id AS group_id, ${QUEUE_COLUMNS_SQL} FROM students s
    JOIN student_groups sg ON sg.student_id = s.id
    ${QUEUE_JOIN_SQL}
    WHERE s.active = 1
      AND s.deleted_at IS NULL
      AND sg.group_id IN (SELECT group_id FROM timetable_groups WHERE timetable_id = ?)
      AND EXISTS (
        SELECT 1 FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id
        WHERE dg.group_id = sg.group_id AND d.active = 1
      )
      AND ('|' || s.preferred_days || '|') LIKE '%|' || ? || '|%'
      AND (s.cooldown_until IS NULL OR date(s.cooldown_until) <= ?)
      AND s.id NOT IN (SELECT student_id FROM invitations WHERE session_id = ? AND group_id IS NULL)
      AND s.id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_sessions ts ON ts.id = inv.session_id
        WHERE ts.date = ? AND inv.status NOT IN ('declined', 'expired', 'invalidated', 'cancelled', 'admin_cancelled')
      )
    ORDER BY ${QUEUE_ORDER_SQL}, RANDOM()
  `).all(session.timetable_id, sessionDow, session.date, req.params.id, session.date) as any[];

  const studentsByGroup = new Map<number, any[]>(groupSlotCounts.map(gsc => [gsc.group_id, []]));
  for (const student of allEligibleStudents) {
    studentsByGroup.get(student.group_id)!.push(student);
  }

  // Check if there are any eligible students at all (manual students still count)
  if (allEligibleStudents.length === 0 && manualInvitations.length === 0) {
    res.status(400).json({ error: 'No eligible students found. Ensure students have group memberships with access to disciplines.' });
    return;
  }

  const instructors = db.prepare(`
    SELECT i.id, ss.id AS slot_id FROM instructors i
    JOIN session_slots ss ON ss.instructor_id = i.id
    WHERE ss.session_id = ? AND ss.removed = 0
    ORDER BY i.last_name ASC, i.first_name ASC
  `).all(req.params.id) as any[];

  // Build a grid of available slots: each timeslot has one spot per instructor
  const slotGrid: Array<{ timeslot: any; instructor: any; timeslotIdx: number }> = [];
  for (let ti = 0; ti < timeslots.length; ti++) {
    for (const instructor of instructors) {
      slotGrid.push({ timeslot: timeslots[ti], instructor, timeslotIdx: ti });
    }
  }
  const slotAvailable = slotGrid.map(() => true);

  // Mark slots occupied by manually-added students as unavailable
  for (const mi of manualInvitations) {
    const idx = slotGrid.findIndex(s => s.timeslot.id === mi.timeslot_id && s.instructor.slot_id === mi.slot_id);
    if (idx !== -1) slotAvailable[idx] = false;
  }

  // Preload preferred timeslot data for all students
  const allPrefs = db.prepare(
    'SELECT student_id, timeslot_id FROM student_preferred_timeslots WHERE timetable_id = ?'
  ).all(session.timetable_id) as Array<{ student_id: number; timeslot_id: number }>;

  const prefsByStudent = new Map<number, Set<number>>();
  for (const p of allPrefs) {
    if (!prefsByStudent.has(p.student_id)) prefsByStudent.set(p.student_id, new Set());
    prefsByStudent.get(p.student_id)!.add(p.timeslot_id);
  }

  const allTimeslotIds = new Set(timeslots.map((t: any) => t.id));

  // Load buddy group memberships for buddy scheduling
  const allBuddyMembers = db.prepare(
    'SELECT bgm.buddy_group_id, bgm.student_id FROM buddy_group_members bgm'
  ).all() as Array<{ buddy_group_id: number; student_id: number }>;
  const buddiesByStudent = new Map<number, Set<number>>();
  const buddyGroupMap = new Map<number, Set<number>>();
  for (const m of allBuddyMembers) {
    if (!buddyGroupMap.has(m.buddy_group_id)) buddyGroupMap.set(m.buddy_group_id, new Set());
    buddyGroupMap.get(m.buddy_group_id)!.add(m.student_id);
  }
  for (const members of buddyGroupMap.values()) {
    for (const sid of members) {
      if (!buddiesByStudent.has(sid)) buddiesByStudent.set(sid, new Set());
      for (const other of members) {
        if (other !== sid) buddiesByStudent.get(sid)!.add(other);
      }
    }
  }

  // Build maps from group id to group name/color for decision log
  const groupNameMap = new Map<number, string>();
  const groupColorMap = new Map<number, string>();
  for (const tg of timetableGroups) {
    groupNameMap.set(tg.group_id, tg.group_name);
    groupColorMap.set(tg.group_id, tg.group_color);
  }

  // Helper: assign a student to the best available slot
  // nearTimeslotIdx: optional hint to prefer slots near this timeslot index (for buddy scheduling)
  function assignStudent(student: any, sessionId: string, groupId: number | null, context?: { candidateRank: number; candidatesConsidered: number; groupQuota?: string; buddyOf?: string; overflow?: boolean }, nearTimeslotIdx?: number): any | null {
    const storedPrefs = prefsByStudent.get(student.id);
    const preferredIds = storedPrefs && storedPrefs.size > 0 ? storedPrefs : allTimeslotIds;

    const preferredIndices = new Set<number>();
    for (let i = 0; i < timeslots.length; i++) {
      if (preferredIds.has(timeslots[i].id)) preferredIndices.add(i);
    }

    let assignedIdx = -1;

    // If nearTimeslotIdx is set (buddy scheduling), prefer slots near buddy's timeslot
    // but only among the student's preferred timeslots
    if (nearTimeslotIdx !== undefined) {
      const nearIndices = new Set<number>();
      nearIndices.add(nearTimeslotIdx);
      if (nearTimeslotIdx > 0) nearIndices.add(nearTimeslotIdx - 1);
      if (nearTimeslotIdx < timeslots.length - 1) nearIndices.add(nearTimeslotIdx + 1);

      for (let i = 0; i < slotGrid.length; i++) {
        if (slotAvailable[i] && nearIndices.has(slotGrid[i].timeslotIdx) && preferredIndices.has(slotGrid[i].timeslotIdx)) {
          assignedIdx = i;
          break;
        }
      }
    }

    // Fallback: any preferred timeslot
    if (assignedIdx === -1) {
      for (let i = 0; i < slotGrid.length; i++) {
        if (slotAvailable[i] && preferredIndices.has(slotGrid[i].timeslotIdx)) {
          assignedIdx = i;
          break;
        }
      }
    }

    if (assignedIdx === -1) return null;

    slotAvailable[assignedIdx] = false;
    const slot = slotGrid[assignedIdx];
    const token = crypto.randomUUID();
    const storedPrefsForLog = prefsByStudent.get(student.id);
    const preferredTimeslots = storedPrefsForLog && storedPrefsForLog.size > 0
      ? timeslots.filter((t: any) => storedPrefsForLog.has(t.id)).map((t: any) => t.start_time)
      : null;
    const clubDaysStr = (db.prepare("SELECT value FROM settings WHERE key = 'club_days'").get() as any)?.value || '0|1|2|3|4|5|6';
    const clubDaysSet = new Set(clubDaysStr.split('|').map(Number));
    const preferredDaysFiltered = student.preferred_days
      ? student.preferred_days.split('|').map(Number).filter((d: number) => clubDaysSet.has(d))
      : null;
    const preferredDays = preferredDaysFiltered && preferredDaysFiltered.length < clubDaysSet.size ? preferredDaysFiltered : null;
    const decisionLog = JSON.stringify({
      trigger: 'batch_schedule',
      last_turn_at: student.last_turn_at ?? null,
      invite_next: student.invite_next_since != null,
      candidate_rank: context?.candidateRank ?? 0,
      candidates_considered: context?.candidatesConsidered ?? 0,
      group_name: groupId ? (groupNameMap.get(groupId) || null) : null,
      group_color: groupId ? (groupColorMap.get(groupId) || null) : null,
      group_quota: context?.groupQuota || null,
      preferred_timeslots: preferredTimeslots,
      preferred_days: preferredDays,
      buddy_placed_near: context?.buddyOf || null,
      overflow: context?.overflow || false,
    });
    insertInvitation.run(sessionId, student.id, slot.timeslot.id, slot.instructor.slot_id, token, groupId, decisionLog);
    return { ...student, token, timeslot_id: slot.timeslot.id, slot_id: slot.instructor.slot_id, start_time: slot.timeslot.start_time, group_id: groupId, timeslotIdx: slot.timeslotIdx };
  }

  const insertInvitation = db.prepare(`
    INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token, group_id, decision_log)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    const invited: any[] = [];
    const invitedStudentIds = new Set<number>();

    // Process each group, allocating its share of slots
    for (const gsc of groupSlotCounts) {
      const groupStudents = studentsByGroup.get(gsc.group_id) || [];
      let groupSlotsUsed = 0;
      const processedInGroup = new Set<number>();
      const tg = timetableGroups.find(t => t.group_id === gsc.group_id);
      const groupQuota = `${gsc.slots} slots (${tg?.percentage ?? 0}%)`;

      for (const student of groupStudents) {
        if (processedInGroup.has(student.id)) continue;
        if (groupSlotsUsed >= gsc.slots) break;
        const candidateRank = groupStudents.indexOf(student) + 1;
        const result = assignStudent(student, req.params.id as string, gsc.group_id, { candidateRank, candidatesConsidered: groupStudents.length, groupQuota });
        if (!result) continue; // This student's preferred slots are full, try next student
        invited.push(result);
        invitedStudentIds.add(student.id);
        processedInGroup.add(student.id);
        groupSlotsUsed++;

        // Try to schedule buddies from the same timetable group near the same timeslot
        const buddyIds = buddiesByStudent.get(student.id);
        if (buddyIds) {
          for (const buddyStudent of groupStudents) {
            if (!buddyIds.has(buddyStudent.id)) continue;
            if (processedInGroup.has(buddyStudent.id)) continue;
            if (groupSlotsUsed >= gsc.slots) break;
            const buddyCandidateRank = groupStudents.indexOf(buddyStudent) + 1;
            const buddyResult = assignStudent(buddyStudent, req.params.id as string, gsc.group_id, { candidateRank: buddyCandidateRank, candidatesConsidered: groupStudents.length, groupQuota, buddyOf: result.first_name + ' ' + result.last_name }, result.timeslotIdx);
            if (!buddyResult) continue; // This buddy couldn't be placed, try others
            invited.push(buddyResult);
            invitedStudentIds.add(buddyStudent.id);
            processedInGroup.add(buddyStudent.id);
            groupSlotsUsed++;
          }
        }
      }
    }

    // Second pass: fill any remaining slots with uninvited eligible students from any group.
    // For each remaining slot we pick a group at random (weighted by the group's timetable
    // percentage) and take the first uninvited candidate in its queue.
    const overflowCandidates = allEligibleStudents.filter(s => !invitedStudentIds.has(s.id));
    const overflowQueues = new Map<number, any[]>();
    for (const student of overflowCandidates) {
      if (!overflowQueues.has(student.group_id)) overflowQueues.set(student.group_id, []);
      overflowQueues.get(student.group_id)!.push(student); // already queue-ordered
    }
    const percentageByGroup = new Map<number, number>(timetableGroups.map(tg => [tg.group_id, tg.percentage]));
    let overflowRank = 0;
    while (overflowQueues.size > 0) {
      const groupIds = [...overflowQueues.keys()];
      const pickedGroupId = weightedPickGroup(groupIds, percentageByGroup);
      const queue = overflowQueues.get(pickedGroupId)!;
      const student = queue.shift()!;
      if (queue.length === 0) overflowQueues.delete(pickedGroupId);
      overflowRank++;
      const result = assignStudent(student, req.params.id as string, pickedGroupId, { candidateRank: overflowRank, candidatesConsidered: overflowCandidates.length, overflow: true });
      if (!result) continue; // This student's preferred slots are full, try next student
      invited.push(result);
    }

    return invited;
  });

  const invited = insertMany();

  // Update session status to scheduled
  db.prepare("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?").run(req.params.id);

  broadcastSession(Number(req.params.id), 'reload', {});
  broadcastSessionCounts(Number(req.params.id));

  res.json({
    session_id: req.params.id,
    total_slots: totalSlots,
    students_invited: invited.length + manualInvitations.length,
    invitations: invited,
  });
});

// ===== Send Invitation Emails =====

router.post('/:id/send-invitations', async (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  const invitations = db.prepare(`
    SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    WHERE inv.session_id = ? AND inv.email_sent = 0 AND inv.status = 'scheduled'
  `).all(req.params.id) as any[];

  if (invitations.length === 0) {
    res.json({ message: 'No pending invitations to send', sent: 0 });
    return;
  }

  const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
  const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';

  let sent = 0;
  const errors: Array<{ student: string; error: string }> = [];

  for (const inv of invitations) {
    try {
      await sendInvitationEmail({
        to: inv.student_email,
        studentName: inv.student_name,
        date: session.date,
        token: inv.token,
        clubName,
        locale: emailLocale,
      });
      db.prepare("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE id = ?").run(inv.id);
      scheduleExpiryForInvitation(inv.id);
      sent++;
    } catch (err: any) {
      errors.push({ student: inv.student_name, error: err.message });
    }
  }

  // Update session status to invitations_sent
  if (sent > 0) {
    db.prepare("UPDATE training_sessions SET status = 'invitations_sent' WHERE id = ?").run(req.params.id);
  }

  broadcastSession(Number(req.params.id), 'reload', {});

  res.json({ sent, errors });
});

// ===== Toggle no-show for an invitation =====

router.post('/:id/invitations/:invitationId/toggle-no-show', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status === 'completed') { res.status(400).json({ error: 'Session already completed' }); return; }

  const invitation = db.prepare('SELECT * FROM invitations WHERE id = ? AND session_id = ?').get(req.params.invitationId, req.params.id) as any;
  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }
  if (invitation.status !== 'confirmed') { res.status(400).json({ error: 'Only confirmed invitations can be toggled' }); return; }

  const newValue = invitation.no_show ? 0 : 1;
  db.prepare('UPDATE invitations SET no_show = ? WHERE id = ?').run(newValue, invitation.id);

  broadcastSession(Number(req.params.id), 'invitation_updated', { id: invitation.id, no_show: newValue });

  res.json({ success: true, no_show: newValue });
});

// ===== Mark session as completed and increment attended_sessions =====

router.post('/:id/complete', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status === 'completed') { res.status(400).json({ error: 'Session already completed' }); return; }

  const confirmedStudents = db.prepare(`
    SELECT student_id, no_show FROM invitations
    WHERE session_id = ? AND status = 'confirmed'
  `).all(req.params.id) as Array<{ student_id: number; no_show: number }>;

  const updateAttended = db.prepare('UPDATE students SET attended_sessions = attended_sessions + 1 WHERE id = ?');
  const updateNoShow = db.prepare('UPDATE students SET no_show_count = no_show_count + 1 WHERE id = ?');
  const completeTransaction = db.transaction(() => {
    for (const { student_id, no_show } of confirmedStudents) {
      if (no_show) {
        updateNoShow.run(student_id);
      } else {
        updateAttended.run(student_id);
      }
    }
    db.prepare("UPDATE training_sessions SET status = 'completed' WHERE id = ?").run(req.params.id);
  });

  completeTransaction();

  broadcastSession(Number(req.params.id), 'session_updated', { status: 'completed' });

  res.json({ success: true, students_credited: confirmedStudents.length });
});

// ===== Manual Student Management =====

// Search available students for a session (not already invited)
router.get('/:id/available-students', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  const q = String(req.query.q || '').trim();
  if (q.length < 2) { res.json([]); return; }

  // Exclude students who have an active (non-terminal) invitation for this session
  const activelyInvited = (db.prepare(
    `SELECT student_id FROM invitations WHERE session_id = ? AND status NOT IN ('declined', 'expired', 'invalidated', 'cancelled', 'admin_cancelled')`
  ).all(req.params.id) as Array<{ student_id: number }>).map(r => r.student_id);

  const placeholders = activelyInvited.length > 0
    ? `AND s.id NOT IN (${activelyInvited.map(() => '?').join(',')})`
    : '';

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.email
    FROM students s
    WHERE s.active = 1
      AND s.deleted_at IS NULL
      AND (s.first_name || ' ' || s.last_name LIKE ? OR s.email LIKE ?)
      ${placeholders}
    ORDER BY s.last_name ASC, s.first_name ASC
    LIMIT 15
  `).all(`%${q}%`, `%${q}%`, ...activelyInvited);

  res.json(students);
});

// Manually add a student to a session
router.post('/:id/invitations', async (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status !== 'draft' && session.status !== 'scheduled' && session.status !== 'invitations_sent') {
    res.status(400).json({ error: 'Can only add students before session is completed' }); return;
  }

  const { student_id, timeslot_id, instructor_id } = req.body;
  if (!student_id || !timeslot_id || !instructor_id) {
    res.status(400).json({ error: 'student_id, timeslot_id, and instructor_id are required' }); return;
  }

  // Look up the session slot for this instructor
  const slot = db.prepare('SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0')
    .get(req.params.id, instructor_id) as { id: number } | undefined;
  if (!slot) { res.status(400).json({ error: 'Instructor is not assigned to this session' }); return; }

  // Check student does not already have an active (non-terminal) invitation for this session
  const existing = db.prepare(
    "SELECT id FROM invitations WHERE session_id = ? AND student_id = ? AND status NOT IN ('declined', 'expired', 'invalidated', 'cancelled', 'admin_cancelled')"
  ).get(req.params.id, student_id);
  if (existing) { res.status(409).json({ error: 'Student already has an active invitation for this session' }); return; }

  // Check slot is not occupied
  const slotTaken = db.prepare(
    "SELECT id FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status NOT IN ('declined', 'expired', 'invalidated', 'cancelled', 'admin_cancelled')"
  ).get(req.params.id, timeslot_id, slot.id);
  if (slotTaken) { res.status(409).json({ error: 'This slot is already occupied' }); return; }

  const token = crypto.randomUUID();
  db.prepare(
    'INSERT INTO invitations (session_id, student_id, timeslot_id, slot_id, token) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, student_id, timeslot_id, slot.id, token);

  // If session was draft, move to scheduled
  if (session.status === 'draft') {
    db.prepare("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?").run(req.params.id);
  }

  // If invitations already sent, immediately send email and mark as invited
  if (session.status === 'invitations_sent') {
    const studentRow = db.prepare('SELECT first_name, last_name, email FROM students WHERE id = ?').get(student_id) as any;
    const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
    const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';
    try {
      await sendInvitationEmail({
        to: studentRow.email,
        studentName: `${studentRow.first_name} ${studentRow.last_name}`,
        date: session.date,
        token,
        clubName,
        locale: emailLocale,
      });
      db.prepare("UPDATE invitations SET email_sent = 1, status = 'invited', invited_at = datetime('now') WHERE token = ?").run(token);
      const newInv = db.prepare("SELECT id FROM invitations WHERE token = ?").get(token) as { id: number } | undefined;
      if (newInv) scheduleExpiryForInvitation(newInv.id);
    } catch (err) {
      console.error('Failed to send invitation email for manually added student:', err);
    }
  }

  res.status(201).json({ success: true });

  // Broadcast after response — new invitation added
  broadcastSession(Number(req.params.id), 'reload', {});
  broadcastSessionCounts(Number(req.params.id));
});

// Remove an invitation from a session
router.delete('/:id/invitations/:invitationId', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status !== 'draft' && session.status !== 'scheduled') {
    res.status(400).json({ error: 'Can only remove students before invitations are sent' }); return;
  }

  const invitation = db.prepare(
    'SELECT id FROM invitations WHERE id = ? AND session_id = ?'
  ).get(req.params.invitationId, req.params.id);
  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }

  db.prepare('DELETE FROM invitations WHERE id = ? AND session_id = ?').run(req.params.invitationId, req.params.id);

  // If no invitations left, revert to draft
  const remaining = (db.prepare(
    'SELECT COUNT(*) AS cnt FROM invitations WHERE session_id = ?'
  ).get(req.params.id) as any).cnt;
  if (remaining === 0) {
    db.prepare("UPDATE training_sessions SET status = 'draft' WHERE id = ?").run(req.params.id);
  }

  res.json({ success: true });
});

// ===== Admin cancel an invitation (after invitations are sent) =====

router.post('/:id/invitations/:invitationId/admin-cancel', async (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status === 'completed') { res.status(400).json({ error: 'Session already completed' }); return; }

  const invitation = db.prepare(`
    SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
           tslot.start_time AS timeslot_start_time,
           d.name AS discipline_name
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots tslot ON tslot.id = inv.timeslot_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    WHERE inv.id = ? AND inv.session_id = ?
  `).get(req.params.invitationId, req.params.id) as any;
  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }
  if (invitation.status === 'declined' || invitation.status === 'expired' || invitation.status === 'invalidated' || invitation.status === 'cancelled' || invitation.status === 'admin_cancelled') {
    res.status(400).json({ error: `Cannot cancel — invitation is already ${invitation.status}` }); return;
  }

  db.prepare(`
    UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Cancel expiry timer if pending
  cancelInvitationExpiry(invitation.id);

  // Broadcast admin cancellation
  broadcastSession(Number(req.params.id), 'invitation_updated', { id: invitation.id, status: 'admin_cancelled' });
  broadcast(`invitation:${invitation.token}`, 'invitation_updated', { status: 'admin_cancelled' });
  broadcastSessionCounts(Number(req.params.id));

  // Send admin cancellation email if the invitation was already sent to the student
  if (invitation.email_sent) {
    try {
      const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
      const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';
      await sendAdminCancellationEmail({
        to: invitation.student_email,
        studentName: invitation.student_name,
        date: session.date,
        startTime: invitation.timeslot_start_time,
        disciplineName: invitation.discipline_name || null,
        clubName,
        locale: emailLocale,
      });
    } catch (err) {
      console.error('Failed to send admin cancellation email:', err);
    }
  }

  res.json({ success: true });
});

// ===== Auto-schedule a student into an empty slot =====
router.post('/:id/auto-schedule-slot', async (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status !== 'invitations_sent') {
    res.status(400).json({ error: 'Auto-scheduling is only available after invitations are sent' }); return;
  }

  const { timeslot_id, instructor_id } = req.body;
  if (!timeslot_id || !instructor_id) {
    res.status(400).json({ error: 'timeslot_id and instructor_id are required' }); return;
  }

  // Look up the session slot for this instructor
  const slot = db.prepare('SELECT id FROM session_slots WHERE session_id = ? AND instructor_id = ? AND removed = 0')
    .get(req.params.id, instructor_id) as { id: number } | undefined;
  if (!slot) { res.status(400).json({ error: 'Instructor is not assigned to this session' }); return; }

  // Check slot is not already occupied
  const slotTaken = db.prepare(
    "SELECT id FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status NOT IN ('declined', 'expired', 'invalidated', 'cancelled', 'admin_cancelled')"
  ).get(req.params.id, timeslot_id, slot.id);
  if (slotTaken) { res.status(409).json({ error: 'This slot is already occupied' }); return; }

  // Look up the most recent vacated invitation for this slot to preserve group consistency
  const lastVacated = db.prepare(
    "SELECT group_id FROM invitations WHERE session_id = ? AND timeslot_id = ? AND slot_id = ? AND status IN ('declined', 'expired', 'invalidated', 'cancelled', 'admin_cancelled') ORDER BY responded_at DESC LIMIT 1"
  ).get(req.params.id, timeslot_id, slot.id) as { group_id: number | null } | undefined;

  const replacement = await findAndInviteReplacement({
    session_id: Number(req.params.id),
    session_date: session.date,
    timeslot_id,
    slot_id: slot.id,
    group_id: lastVacated?.group_id ?? null,
  });

  res.json({ success: true, replacement });
});

// ===== Cancel entire session =====
router.post('/:id/cancel', async (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status === 'completed') { res.status(400).json({ error: 'Cannot cancel a completed session' }); return; }
  if (session.status === 'cancelled') { res.status(400).json({ error: 'Session is already cancelled' }); return; }

  // Cancel all expiry timers for this session
  cancelAllSessionTimers(Number(req.params.id));

  // Find all active invitations (for emails)
  const activeInvitations = db.prepare(`
    SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
           d.name AS discipline_name, ts.start_time
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots ts ON ts.id = inv.timeslot_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    WHERE inv.session_id = ? AND inv.status IN ('invited', 'confirmed')
  `).all(req.params.id) as any[];

  // Cancel all active invitations
  db.prepare(`
    UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now')
    WHERE session_id = ? AND status IN ('scheduled', 'invited', 'confirmed')
  `).run(req.params.id);

  // Update session status
  db.prepare("UPDATE training_sessions SET status = 'cancelled' WHERE id = ?").run(req.params.id);

  // Send cancellation emails to students who had been invited or confirmed
  if (activeInvitations.length > 0) {
    const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
    const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';

    for (const inv of activeInvitations) {
      try {
        await sendAdminCancellationEmail({
          to: inv.student_email,
          studentName: inv.student_name,
          date: session.date,
          startTime: inv.start_time,
          disciplineName: inv.discipline_name,
          clubName,
          locale: emailLocale,
        });
      } catch (err) {
        console.error('Failed to send cancellation email:', err);
      }
    }
  }

  res.json({ success: true, cancelled_invitations: activeInvitations.length });

  // Broadcast session cancellation
  broadcastSession(Number(req.params.id), 'reload', {});
  broadcastSessionCounts(Number(req.params.id));
  for (const inv of activeInvitations) {
    broadcast(`invitation:${inv.token}`, 'invitation_updated', { status: 'admin_cancelled' });
  }
});

// ===== Reactivate cancelled session =====
router.post('/:id/reactivate', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status !== 'cancelled') { res.status(400).json({ error: 'Only cancelled sessions can be reactivated' }); return; }

  // Cancel all expiry timers for this session
  cancelAllSessionTimers(Number(req.params.id));

  // Delete all invitations belonging to this session
  db.prepare('DELETE FROM invitations WHERE session_id = ?').run(req.params.id);

  // Update session status to draft to start fresh
  db.prepare("UPDATE training_sessions SET status = 'draft' WHERE id = ?").run(req.params.id);

  res.json({ success: true, new_status: 'draft' });

  // Broadcast structural change
  broadcastSession(Number(req.params.id), 'reload', {});
  broadcastSessionCounts(Number(req.params.id));
});

export default router;
