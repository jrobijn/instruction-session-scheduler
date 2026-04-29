import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail, sendAdminCancellationEmail, getEmailStrings } from '../email.js';

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

// List all training sessions
router.get('/', (_req: Request, res: Response) => {
  const sessions = db.prepare(`
    SELECT ts.*,
      (SELECT COUNT(*) FROM session_instructors WHERE session_id = ts.id) AS instructor_count,
      (SELECT COUNT(*) FROM invitations WHERE session_id = ts.id) AS invitation_count,
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
    JOIN session_instructors si ON si.instructor_id = i.id
    WHERE si.session_id = ?
    ORDER BY i.last_name ASC, i.first_name ASC
  `).all(req.params.id);

  // Get timeslots from the attached timetable
  let timeslots: any[] = [];
  let timetable = null;
  if (session.timetable_id) {
    timetable = db.prepare('SELECT * FROM timetables WHERE id = ?').get(session.timetable_id);
    timeslots = db.prepare('SELECT * FROM timeslots WHERE timetable_id = ? ORDER BY start_time ASC').all(session.timetable_id);
  }

  const invitations = db.prepare(`
    SELECT inv.*, inv.no_show, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email, s.membership_id AS student_membership_id, s.attended_sessions,
           d.name AS discipline_name, d.abbreviation AS discipline_abbreviation, ts.start_time AS timeslot_start_time,
           i.first_name || ' ' || i.last_name AS instructor_name,
           g.name AS group_name, g.color AS group_color
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots ts ON ts.id = inv.timeslot_id
    JOIN instructors i ON i.id = inv.instructor_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    LEFT JOIN groups g ON g.id = inv.group_id
    WHERE inv.session_id = ?
    ORDER BY ts.start_time ASC, i.last_name ASC, i.first_name ASC
  `).all(req.params.id);

  res.json({ ...session, instructors, timeslots, invitations, timetable });
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

  try {
    db.prepare('INSERT INTO session_instructors (session_id, instructor_id) VALUES (?, ?)').run(req.params.id, instructor_id);
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

  const assignment = db.prepare('SELECT * FROM session_instructors WHERE session_id = ? AND instructor_id = ?')
    .get(req.params.id, req.params.instructorId) as any;
  if (!assignment) { res.status(404).json({ error: 'Assignment not found' }); return; }

  // Find all invitations for this instructor in this session
  const affectedInvitations = db.prepare(`
    SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email,
           tslot.start_time AS timeslot_start_time, d.name AS discipline_name
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots tslot ON tslot.id = inv.timeslot_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    WHERE inv.session_id = ? AND inv.instructor_id = ?
  `).all(req.params.id, req.params.instructorId) as any[];

  const clubName = (db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get() as any)?.value || 'Sports Club';
  const emailLocale = (db.prepare("SELECT value FROM settings WHERE key = 'email_locale'").get() as any)?.value || 'en';

  for (const inv of affectedInvitations) {
    if (inv.status === 'invited' || inv.status === 'confirmed') {
      // Admin-cancel active invitations and notify
      db.prepare("UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE id = ?").run(inv.id);
      db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(inv.student_id);
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
      // Pre-send: just delete and reverse priority
      db.prepare('DELETE FROM invitations WHERE id = ?').run(inv.id);
      db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(inv.student_id);
    }
    // declined/expired/cancelled/admin_cancelled: leave as-is (no priority reversal needed)
  }
  normalizePriorities();

  // Remove the instructor assignment
  db.prepare('DELETE FROM session_instructors WHERE session_id = ? AND instructor_id = ?')
    .run(req.params.id, req.params.instructorId);

  res.json({ success: true, cancelled: affectedInvitations.filter(i => i.status === 'invited' || i.status === 'confirmed').length });
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
  const oldAssignment = db.prepare('SELECT * FROM session_instructors WHERE session_id = ? AND instructor_id = ?')
    .get(req.params.id, oldInstructorId) as any;
  if (!oldAssignment) { res.status(404).json({ error: 'Original instructor not assigned to this session' }); return; }

  // Verify new instructor exists
  const newInstructor = db.prepare('SELECT * FROM instructors WHERE id = ?').get(newInstructorId) as any;
  if (!newInstructor) { res.status(400).json({ error: 'New instructor not found' }); return; }

  // Verify new instructor is not already assigned
  const existingAssignment = db.prepare('SELECT * FROM session_instructors WHERE session_id = ? AND instructor_id = ?')
    .get(req.params.id, newInstructorId) as any;
  if (existingAssignment) { res.status(409).json({ error: 'New instructor is already assigned to this session' }); return; }

  // Reassign only active invitations to new instructor; cancelled/declined/expired ones become orphaned
  const reassigned = db.prepare(
    `UPDATE invitations SET instructor_id = ? WHERE session_id = ? AND instructor_id = ? AND status IN ('scheduled','invited','confirmed')`
  ).run(newInstructorId, req.params.id, oldInstructorId);

  // Swap the instructor assignment
  db.prepare('DELETE FROM session_instructors WHERE session_id = ? AND instructor_id = ?')
    .run(req.params.id, oldInstructorId);
  db.prepare('INSERT INTO session_instructors (session_id, instructor_id) VALUES (?, ?)')
    .run(req.params.id, newInstructorId);

  res.json({ success: true, reassigned: reassigned.changes });
});

// ===== Schedule Generation =====

// Generate schedule for a session: group-based allocation with preferred timeslots
router.post('/:id/generate-schedule', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  if (!session.timetable_id) { res.status(400).json({ error: 'No timetable attached to this session' }); return; }

  const instructorCount = (db.prepare('SELECT COUNT(*) AS cnt FROM session_instructors WHERE session_id = ?')
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

  // Reverse priority for students whose auto-generated invitations are being removed
  const removedStudents = db.prepare(
    'SELECT DISTINCT student_id FROM invitations WHERE session_id = ? AND group_id IS NOT NULL'
  ).all(req.params.id) as Array<{ student_id: number }>;
  const decrementPriority = db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?');
  for (const { student_id } of removedStudents) {
    decrementPriority.run(student_id);
  }
  db.prepare('DELETE FROM invitations WHERE session_id = ? AND group_id IS NOT NULL').run(req.params.id);
  normalizePriorities();

  const availableSlots = totalSlots - manualInvitations.length;

  // Get groups assigned to this timetable with percentages
  const timetableGroups = db.prepare(`
    SELECT tg.group_id, tg.percentage, g.name AS group_name, g.priority
    FROM timetable_groups tg
    JOIN groups g ON g.id = tg.group_id
    WHERE tg.timetable_id = ?
    ORDER BY g.priority ASC
  `).all(session.timetable_id) as Array<{ group_id: number; percentage: number; group_name: string; priority: number }>;

  if (timetableGroups.length === 0) {
    res.status(400).json({ error: 'No groups assigned to this timetable' }); return;
  }

  // Compute slots per group from percentages based on remaining available slots
  const groupSlotCounts: Array<{ group_id: number; slots: number; priority: number }> = [];
  let allocated = 0;
  for (const tg of timetableGroups) {
    const slots = Math.floor(availableSlots * tg.percentage / 100);
    groupSlotCounts.push({ group_id: tg.group_id, slots, priority: tg.priority });
    allocated += slots;
  }
  // Distribute remainder to highest-priority group (lowest priority number)
  let remainder = availableSlots - allocated;
  for (const gsc of groupSlotCounts) {
    if (remainder <= 0) break;
    gsc.slots++;
    remainder--;
  }

  // Get active students ordered by attended sessions (lowest first), then by name
  // Filter by preferred_days matching the session's day of week
  const sessionDow = String(new Date(session.date + 'T00:00:00').getDay());
  const allEligibleStudents = db.prepare(`
    SELECT s.* FROM students s
    WHERE s.active = 1
      AND ('|' || s.preferred_days || '|') LIKE '%|' || ? || '|%'
      AND (s.cooldown_until IS NULL OR s.cooldown_until <= datetime('now'))
      AND s.id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_sessions ts ON ts.id = inv.session_id
        WHERE ts.date = ? AND inv.status NOT IN ('declined', 'expired', 'cancelled', 'admin_cancelled')
      )
    ORDER BY s.priority ASC, s.last_name ASC, s.first_name ASC
  `).all(sessionDow, session.date) as any[];

  // Load group memberships for all students
  const allMemberships = db.prepare(
    'SELECT sg.student_id, sg.group_id FROM student_groups sg'
  ).all() as Array<{ student_id: number; group_id: number }>;
  const membershipsByStudent = new Map<number, Set<number>>();
  for (const m of allMemberships) {
    if (!membershipsByStudent.has(m.student_id)) membershipsByStudent.set(m.student_id, new Set());
    membershipsByStudent.get(m.student_id)!.add(m.group_id);
  }

  // Load discipline-group associations to check which students have available disciplines
  const allDisciplineGroups = db.prepare(
    'SELECT dg.discipline_id, dg.group_id FROM discipline_groups dg JOIN disciplines d ON d.id = dg.discipline_id WHERE d.active = 1'
  ).all() as Array<{ discipline_id: number; group_id: number }>;
  const disciplineGroupIds = new Set<number>();
  for (const dg of allDisciplineGroups) {
    disciplineGroupIds.add(dg.group_id);
  }

  // Determine the timetable group IDs (the groups assigned to this timetable)
  const timetableGroupIds = new Set(timetableGroups.map(tg => tg.group_id));

  // Build a priority lookup for timetable groups (lower number = higher priority)
  const timetableGroupPriority = new Map<number, number>();
  for (const tg of timetableGroups) {
    timetableGroupPriority.set(tg.group_id, tg.priority);
  }

  // For each student, check if they have at least one available discipline through their timetable groups
  const studentHasDisciplines = (studentId: number): boolean => {
    const groups = membershipsByStudent.get(studentId);
    if (!groups) return false;
    for (const gid of groups) {
      if (timetableGroupIds.has(gid) && disciplineGroupIds.has(gid)) return true;
    }
    return false;
  };

  // For each student, find their best (highest priority = lowest number) timetable group
  // Only considers groups that are both: (1) assigned to this timetable and (2) the student is a member of
  const studentsByGroup = new Map<number, any[]>();
  for (const gsc of groupSlotCounts) {
    studentsByGroup.set(gsc.group_id, []);
  }

  const assignedStudents = new Set<number>();
  const manualStudentIds = new Set(manualInvitations.map((mi: any) => mi.student_id as number));

  for (const student of allEligibleStudents) {
    if (manualStudentIds.has(student.id)) continue;
    const groups = membershipsByStudent.get(student.id);
    if (!groups) continue;

    // Find the highest-priority timetable group this student belongs to
    let bestGroupId: number | null = null;
    let bestPriority = Infinity;
    for (const gid of groups) {
      if (!timetableGroupIds.has(gid)) continue;
      const p = timetableGroupPriority.get(gid)!;
      if (p < bestPriority) {
        bestPriority = p;
        bestGroupId = gid;
      }
    }
    if (bestGroupId === null) continue; // student isn't in any timetable group

    // Skip students with no available disciplines through their timetable groups
    if (!studentHasDisciplines(student.id)) continue;

    studentsByGroup.get(bestGroupId)!.push(student);
    assignedStudents.add(student.id);
  }

  // Sort timetable groups by priority (lowest first = highest priority)
  const sortedGroups = [...groupSlotCounts].sort((a, b) => a.priority - b.priority);

  // Check if there are any eligible students at all (manual students still count)
  if (assignedStudents.size === 0 && manualInvitations.length === 0) {
    res.status(400).json({ error: 'No eligible students found. Ensure students have group memberships with access to disciplines.' });
    return;
  }

  const instructors = db.prepare(`
    SELECT i.id FROM instructors i
    JOIN session_instructors si ON si.instructor_id = i.id
    WHERE si.session_id = ?
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
    const idx = slotGrid.findIndex(s => s.timeslot.id === mi.timeslot_id && s.instructor.id === mi.instructor_id);
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

  // Helper: assign a student to the best available slot
  // nearTimeslotIdx: optional hint to prefer slots near this timeslot index (for buddy scheduling)
  function assignStudent(student: any, sessionId: string, groupId: number | null, nearTimeslotIdx?: number): any | null {
    const storedPrefs = prefsByStudent.get(student.id);
    const preferredIds = storedPrefs && storedPrefs.size > 0 ? storedPrefs : allTimeslotIds;

    const preferredIndices = new Set<number>();
    for (let i = 0; i < timeslots.length; i++) {
      if (preferredIds.has(timeslots[i].id)) preferredIndices.add(i);
    }

    const adjacentIndices = new Set<number>();
    for (const idx of preferredIndices) {
      if (idx > 0 && !preferredIndices.has(idx - 1)) adjacentIndices.add(idx - 1);
      if (idx < timeslots.length - 1 && !preferredIndices.has(idx + 1)) adjacentIndices.add(idx + 1);
    }

    let assignedIdx = -1;

    // If nearTimeslotIdx is set (buddy scheduling), prefer slots at same or adjacent timeslot
    // but only among the student's own preferred timeslots
    if (nearTimeslotIdx !== undefined) {
      const nearIndices = new Set<number>();
      nearIndices.add(nearTimeslotIdx);
      if (nearTimeslotIdx > 0) nearIndices.add(nearTimeslotIdx - 1);
      if (nearTimeslotIdx < timeslots.length - 1) nearIndices.add(nearTimeslotIdx + 1);

      // Try: near AND preferred
      for (let i = 0; i < slotGrid.length; i++) {
        if (slotAvailable[i] && nearIndices.has(slotGrid[i].timeslotIdx) && preferredIndices.has(slotGrid[i].timeslotIdx)) {
          assignedIdx = i;
          break;
        }
      }
      // Try: near (even if not in student's preferred, buddy proximity is soft)
      if (assignedIdx === -1) {
        for (let i = 0; i < slotGrid.length; i++) {
          if (slotAvailable[i] && nearIndices.has(slotGrid[i].timeslotIdx)) {
            assignedIdx = i;
            break;
          }
        }
      }
    }

    // Standard 3-pass fallback: preferred → adjacent → any
    if (assignedIdx === -1) {
      for (let i = 0; i < slotGrid.length; i++) {
        if (slotAvailable[i] && preferredIndices.has(slotGrid[i].timeslotIdx)) {
          assignedIdx = i;
          break;
        }
      }
    }

    if (assignedIdx === -1) {
      for (let i = 0; i < slotGrid.length; i++) {
        if (slotAvailable[i] && adjacentIndices.has(slotGrid[i].timeslotIdx)) {
          assignedIdx = i;
          break;
        }
      }
    }

    if (assignedIdx === -1) {
      for (let i = 0; i < slotGrid.length; i++) {
        if (slotAvailable[i]) {
          assignedIdx = i;
          break;
        }
      }
    }

    if (assignedIdx === -1) return null;

    slotAvailable[assignedIdx] = false;
    const slot = slotGrid[assignedIdx];
    const token = crypto.randomUUID();
    insertInvitation.run(sessionId, student.id, slot.timeslot.id, slot.instructor.id, token, groupId);
    return { ...student, token, timeslot_id: slot.timeslot.id, instructor_id: slot.instructor.id, start_time: slot.timeslot.start_time, group_id: groupId, timeslotIdx: slot.timeslotIdx };
  }

  const insertInvitation = db.prepare(`
    INSERT INTO invitations (session_id, student_id, timeslot_id, instructor_id, token, group_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    const invited: any[] = [];
    const invitedStudentIds = new Set<number>();

    // Process groups in priority order, allocating each group's share of slots
    for (const gsc of sortedGroups) {
      const groupStudents = studentsByGroup.get(gsc.group_id) || [];
      let groupSlotsUsed = 0;
      const processedInGroup = new Set<number>();

      for (const student of groupStudents) {
        if (processedInGroup.has(student.id)) continue;
        if (groupSlotsUsed >= gsc.slots) break;
        const result = assignStudent(student, req.params.id as string, gsc.group_id);
        if (!result) break; // No more slots globally
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
            const buddyResult = assignStudent(buddyStudent, req.params.id as string, gsc.group_id, result.timeslotIdx);
            if (!buddyResult) continue; // This buddy couldn't be placed, try others
            invited.push(buddyResult);
            invitedStudentIds.add(buddyStudent.id);
            processedInGroup.add(buddyStudent.id);
            groupSlotsUsed++;
          }
        }
      }
    }

    // Second pass: fill any remaining slots with uninvited eligible students (regardless of group)
    for (const student of allEligibleStudents) {
      if (invitedStudentIds.has(student.id)) continue;
      if (!assignedStudents.has(student.id)) continue; // must still pass group/discipline checks
      // Find which group this student was assigned to
      let studentGroupId: number | null = null;
      for (const group of sortedGroups) {
        const studs = studentsByGroup.get(group.group_id) || [];
        if (studs.some((s: any) => s.id === student.id)) { studentGroupId = group.group_id; break; }
      }
      const result = assignStudent(student, req.params.id as string, studentGroupId);
      if (!result) break; // No more slots globally
      invited.push(result);
    }

    return invited;
  });

  const invited = insertMany();

  // Increment priority for each newly invited student
  const incrementPriority = db.prepare('UPDATE students SET priority = priority + 1 WHERE id = ?');
  for (const inv of invited) {
    incrementPriority.run(inv.id);
  }
  normalizePriorities();

  // Update session status to scheduled
  db.prepare("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?").run(req.params.id);

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
      db.prepare("UPDATE invitations SET email_sent = 1, status = 'invited' WHERE id = ?").run(inv.id);
      sent++;
    } catch (err: any) {
      errors.push({ student: inv.student_name, error: err.message });
    }
  }

  // Update session status to invitations_sent
  if (sent > 0) {
    db.prepare("UPDATE training_sessions SET status = 'invitations_sent' WHERE id = ?").run(req.params.id);
  }

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
    // Priority was already incremented at invitation time, so no increment needed here.
    // Normalize priorities in case any shifts occurred.
    normalizePriorities();
    db.prepare("UPDATE training_sessions SET status = 'completed' WHERE id = ?").run(req.params.id);
  });

  completeTransaction();
  res.json({ success: true, students_credited: confirmedStudents.length });
});

// ===== Manual Student Management =====

// Search available students for a session (not already invited)
router.get('/:id/available-students', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  const q = String(req.query.q || '').trim();
  if (q.length < 2) { res.json([]); return; }

  const alreadyInvited = (db.prepare(
    `SELECT student_id FROM invitations WHERE session_id = ?`
  ).all(req.params.id) as Array<{ student_id: number }>).map(r => r.student_id);

  const placeholders = alreadyInvited.length > 0
    ? `AND s.id NOT IN (${alreadyInvited.map(() => '?').join(',')})`
    : '';

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.email
    FROM students s
    WHERE s.active = 1
      AND (s.first_name || ' ' || s.last_name LIKE ? OR s.email LIKE ?)
      ${placeholders}
    ORDER BY s.last_name ASC, s.first_name ASC
    LIMIT 15
  `).all(`%${q}%`, `%${q}%`, ...alreadyInvited);

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

  // Check student is not already in this session
  const existing = db.prepare(
    'SELECT id FROM invitations WHERE session_id = ? AND student_id = ?'
  ).get(req.params.id, student_id);
  if (existing) { res.status(409).json({ error: 'Student is already in this session' }); return; }

  // Check slot is not occupied
  const slotTaken = db.prepare(
    "SELECT id FROM invitations WHERE session_id = ? AND timeslot_id = ? AND instructor_id = ? AND status NOT IN ('declined', 'expired', 'cancelled', 'admin_cancelled')"
  ).get(req.params.id, timeslot_id, instructor_id);
  if (slotTaken) { res.status(409).json({ error: 'This slot is already occupied' }); return; }

  const token = crypto.randomUUID();
  db.prepare(
    'INSERT INTO invitations (session_id, student_id, timeslot_id, instructor_id, token) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, student_id, timeslot_id, instructor_id, token);

  // Increment priority for the manually added student
  db.prepare('UPDATE students SET priority = priority + 1 WHERE id = ?').run(student_id);
  normalizePriorities();

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
      db.prepare("UPDATE invitations SET email_sent = 1, status = 'invited' WHERE token = ?").run(token);
    } catch (err) {
      console.error('Failed to send invitation email for manually added student:', err);
    }
  }

  res.status(201).json({ success: true });
});

// Remove an invitation from a session
router.delete('/:id/invitations/:invitationId', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status !== 'draft' && session.status !== 'scheduled') {
    res.status(400).json({ error: 'Can only remove students before invitations are sent' }); return;
  }

  // Get the student_id before deleting so we can reverse their priority
  const invitation = db.prepare(
    'SELECT student_id FROM invitations WHERE id = ? AND session_id = ?'
  ).get(req.params.invitationId, req.params.id) as { student_id: number } | undefined;
  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return; }

  db.prepare('DELETE FROM invitations WHERE id = ? AND session_id = ?').run(req.params.invitationId, req.params.id);

  // Reverse priority for the removed student
  db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(invitation.student_id);
  normalizePriorities();

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
  if (invitation.status === 'declined' || invitation.status === 'expired' || invitation.status === 'cancelled' || invitation.status === 'admin_cancelled') {
    res.status(400).json({ error: `Cannot cancel — invitation is already ${invitation.status}` }); return;
  }

  db.prepare(`
    UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now') WHERE id = ?
  `).run(invitation.id);

  // Reverse the priority increase that was applied when this student was invited
  db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?').run(invitation.student_id);
  normalizePriorities();

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

// ===== Cancel entire session =====
router.post('/:id/cancel', async (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }
  if (session.status === 'completed') { res.status(400).json({ error: 'Cannot cancel a completed session' }); return; }
  if (session.status === 'cancelled') { res.status(400).json({ error: 'Session is already cancelled' }); return; }

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

  // Find all invitations that will be cancelled (for priority reversal)
  const allCancelledStudents = db.prepare(`
    SELECT student_id FROM invitations
    WHERE session_id = ? AND status IN ('scheduled', 'invited', 'confirmed')
  `).all(req.params.id) as Array<{ student_id: number }>;

  // Cancel all active invitations
  db.prepare(`
    UPDATE invitations SET status = 'admin_cancelled', responded_at = datetime('now')
    WHERE session_id = ? AND status IN ('scheduled', 'invited', 'confirmed')
  `).run(req.params.id);

  // Reverse priority for all affected students
  const decrementPriority = db.prepare('UPDATE students SET priority = priority - 1 WHERE id = ?');
  for (const { student_id } of allCancelledStudents) {
    decrementPriority.run(student_id);
  }
  normalizePriorities();

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
});

export default router;
