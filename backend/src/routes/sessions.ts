import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail } from '../email.js';

const router = Router();

// List all training sessions
router.get('/', (_req: Request, res: Response) => {
  const sessions = db.prepare(`
    SELECT ts.*,
      (SELECT COUNT(*) FROM session_instructors WHERE session_id = ts.id) AS instructor_count,
      (SELECT COUNT(*) FROM invitations WHERE session_id = ts.id) AS invitation_count
    FROM training_sessions ts
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

  const timeslots = db.prepare(`
    SELECT * FROM timeslots WHERE session_id = ? ORDER BY start_time ASC
  `).all(req.params.id);

  const invitations = db.prepare(`
    SELECT inv.*, inv.no_show, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email, s.attended_sessions,
           d.name AS discipline_name, ts.start_time AS timeslot_start_time,
           i.first_name || ' ' || i.last_name AS instructor_name
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots ts ON ts.id = inv.timeslot_id
    JOIN instructors i ON i.id = inv.instructor_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    WHERE inv.session_id = ?
    ORDER BY ts.start_time ASC, i.last_name ASC, i.first_name ASC
  `).all(req.params.id);

  res.json({ ...session, instructors, timeslots, invitations });
});

// Create training session
router.post('/', (req: Request, res: Response) => {
  const { date, notes } = req.body;
  if (!date) { res.status(400).json({ error: 'Date is required' }); return; }

  try {
    const result = db.prepare('INSERT INTO training_sessions (date, notes) VALUES (?, ?)').run(date, notes || null);
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
  const { date, notes, status } = req.body;
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  db.prepare(`
    UPDATE training_sessions SET
      date = COALESCE(?, date),
      notes = COALESCE(?, notes),
      status = COALESCE(?, status)
    WHERE id = ?
  `).run(date ?? null, notes ?? null, status ?? null, req.params.id);

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
router.delete('/:id/instructors/:instructorId', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM session_instructors WHERE session_id = ? AND instructor_id = ?')
    .run(req.params.id, req.params.instructorId);
  if (result.changes === 0) { res.status(404).json({ error: 'Assignment not found' }); return; }
  res.json({ success: true });
});

// ===== Timeslot Management =====

// Add a timeslot to a session
router.post('/:id/timeslots', (req: Request, res: Response) => {
  const { start_time } = req.body;
  if (!start_time) { res.status(400).json({ error: 'start_time is required' }); return; }

  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  try {
    const result = db.prepare('INSERT INTO timeslots (session_id, start_time) VALUES (?, ?)').run(req.params.id, start_time);
    const timeslot = db.prepare('SELECT * FROM timeslots WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(timeslot);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A timeslot with this start time already exists for this session' });
      return;
    }
    throw err;
  }
});

// Delete a timeslot from a session
router.delete('/:id/timeslots/:timeslotId', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM timeslots WHERE id = ? AND session_id = ?')
    .run(req.params.timeslotId, req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Timeslot not found' }); return; }
  res.json({ success: true });
});

// ===== Schedule Generation =====

// Generate schedule for a session: allocate students with lowest attended sessions
router.post('/:id/generate-schedule', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM training_sessions WHERE id = ?').get(req.params.id) as any;
  if (!session) { res.status(404).json({ error: 'Training session not found' }); return; }

  const instructorCount = (db.prepare('SELECT COUNT(*) AS cnt FROM session_instructors WHERE session_id = ?')
    .get(req.params.id) as any).cnt;
  if (instructorCount === 0) { res.status(400).json({ error: 'No instructors assigned for this session' }); return; }

  const timeslots = db.prepare('SELECT * FROM timeslots WHERE session_id = ? ORDER BY start_time ASC')
    .all(req.params.id) as any[];
  if (timeslots.length === 0) { res.status(400).json({ error: 'No timeslots defined for this session' }); return; }

  // Each timeslot has one spot per instructor
  const totalSlots = timeslots.length * instructorCount;

  // Remove existing invitations for this session
  db.prepare('DELETE FROM invitations WHERE session_id = ?').run(req.params.id);

  // Get active students ordered by attended sessions (lowest first), then by name
  const students = db.prepare(`
    SELECT s.* FROM students s
    WHERE s.active = 1
      AND s.id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_sessions ts ON ts.id = inv.session_id
        WHERE ts.date = ? AND inv.status != 'declined'
      )
    ORDER BY s.attended_sessions ASC, s.last_name ASC, s.first_name ASC
  `).all(session.date) as any[];

  const insertInvitation = db.prepare(`
    INSERT INTO invitations (session_id, student_id, timeslot_id, instructor_id, token)
    VALUES (?, ?, ?, ?, ?)
  `);

  const instructors = db.prepare(`
    SELECT i.id FROM instructors i
    JOIN session_instructors si ON si.instructor_id = i.id
    WHERE si.session_id = ?
    ORDER BY i.last_name ASC, i.first_name ASC
  `).all(req.params.id) as any[];

  const insertMany = db.transaction((studentsArr: any[], sessionId: string | string[], slots: any[]) => {
    const invited: any[] = [];
    let studentIdx = 0;
    // Fill timeslots: for each timeslot, assign one student per instructor
    for (const timeslot of slots) {
      for (const instructor of instructors) {
        if (studentIdx >= studentsArr.length) break;
        const token = crypto.randomUUID();
        insertInvitation.run(sessionId, studentsArr[studentIdx].id, timeslot.id, instructor.id, token);
        invited.push({ ...studentsArr[studentIdx], token, timeslot_id: timeslot.id, instructor_id: instructor.id, start_time: timeslot.start_time });
        studentIdx++;
      }
      if (studentIdx >= studentsArr.length) break;
    }
    return invited;
  });

  const invited = insertMany(students, req.params.id, timeslots);

  // Update session status to scheduled
  db.prepare("UPDATE training_sessions SET status = 'scheduled' WHERE id = ?").run(req.params.id);

  res.json({
    session_id: req.params.id,
    total_slots: totalSlots,
    students_invited: invited.length,
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
  const subject = (db.prepare("SELECT value FROM settings WHERE key = 'invitation_email_subject'").get() as any)?.value
    || 'You are invited to a coaching session!';

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
        subject,
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
    db.prepare("UPDATE training_sessions SET status = 'completed' WHERE id = ?").run(req.params.id);
  });

  completeTransaction();
  res.json({ success: true, students_credited: confirmedStudents.length });
});

export default router;
