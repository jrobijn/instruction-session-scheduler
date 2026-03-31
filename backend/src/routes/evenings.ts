import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail } from '../email.js';

const router = Router();

// List all training evenings
router.get('/', (_req: Request, res: Response) => {
  const evenings = db.prepare(`
    SELECT te.*,
      (SELECT COUNT(*) FROM evening_instructors WHERE evening_id = te.id) AS instructor_count,
      (SELECT COUNT(*) FROM invitations WHERE evening_id = te.id) AS invitation_count
    FROM training_evenings te
    ORDER BY te.date DESC
  `).all();
  res.json(evenings);
});

// Get single training evening with details
router.get('/:id', (req: Request, res: Response) => {
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id) as any;
  if (!evening) { res.status(404).json({ error: 'Training evening not found' }); return; }

  const instructors = db.prepare(`
    SELECT i.* FROM instructors i
    JOIN evening_instructors ei ON ei.instructor_id = i.id
    WHERE ei.evening_id = ?
    ORDER BY i.last_name ASC, i.first_name ASC
  `).all(req.params.id);

  const timeslots = db.prepare(`
    SELECT * FROM timeslots WHERE evening_id = ? ORDER BY start_time ASC
  `).all(req.params.id);

  const invitations = db.prepare(`
    SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email, s.attended_sessions,
           d.name AS discipline_name, ts.start_time AS timeslot_start_time,
           i.first_name || ' ' || i.last_name AS instructor_name
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    JOIN timeslots ts ON ts.id = inv.timeslot_id
    JOIN instructors i ON i.id = inv.instructor_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    WHERE inv.evening_id = ?
    ORDER BY ts.start_time ASC, i.last_name ASC, i.first_name ASC
  `).all(req.params.id);

  res.json({ ...evening, instructors, timeslots, invitations });
});

// Create training evening
router.post('/', (req: Request, res: Response) => {
  const { date, notes } = req.body;
  if (!date) { res.status(400).json({ error: 'Date is required' }); return; }

  try {
    const result = db.prepare('INSERT INTO training_evenings (date, notes) VALUES (?, ?)').run(date, notes || null);
    const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(evening);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A training evening already exists for this date' });
      return;
    }
    throw err;
  }
});

// Update training evening
router.put('/:id', (req: Request, res: Response) => {
  const { date, notes, status } = req.body;
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) { res.status(404).json({ error: 'Training evening not found' }); return; }

  db.prepare(`
    UPDATE training_evenings SET
      date = COALESCE(?, date),
      notes = COALESCE(?, notes),
      status = COALESCE(?, status)
    WHERE id = ?
  `).run(date ?? null, notes ?? null, status ?? null, req.params.id);

  const updated = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete training evening
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM training_evenings WHERE id = ?').run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Training evening not found' }); return; }
  res.json({ success: true });
});

// ===== Instructor Assignment =====

// Assign instructor to evening
router.post('/:id/instructors', (req: Request, res: Response) => {
  const { instructor_id } = req.body;
  if (!instructor_id) { res.status(400).json({ error: 'instructor_id is required' }); return; }

  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) { res.status(404).json({ error: 'Training evening not found' }); return; }

  try {
    db.prepare('INSERT INTO evening_instructors (evening_id, instructor_id) VALUES (?, ?)').run(req.params.id, instructor_id);
    res.status(201).json({ success: true });
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Instructor already assigned to this evening' });
      return;
    }
    if (err.message.includes('FOREIGN KEY')) {
      res.status(400).json({ error: 'Invalid instructor' });
      return;
    }
    throw err;
  }
});

// Remove instructor from evening
router.delete('/:id/instructors/:instructorId', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM evening_instructors WHERE evening_id = ? AND instructor_id = ?')
    .run(req.params.id, req.params.instructorId);
  if (result.changes === 0) { res.status(404).json({ error: 'Assignment not found' }); return; }
  res.json({ success: true });
});

// ===== Timeslot Management =====

// Add a timeslot to an evening
router.post('/:id/timeslots', (req: Request, res: Response) => {
  const { start_time } = req.body;
  if (!start_time) { res.status(400).json({ error: 'start_time is required' }); return; }

  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) { res.status(404).json({ error: 'Training evening not found' }); return; }

  try {
    const result = db.prepare('INSERT INTO timeslots (evening_id, start_time) VALUES (?, ?)').run(req.params.id, start_time);
    const timeslot = db.prepare('SELECT * FROM timeslots WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(timeslot);
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A timeslot with this start time already exists for this evening' });
      return;
    }
    throw err;
  }
});

// Delete a timeslot from an evening
router.delete('/:id/timeslots/:timeslotId', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM timeslots WHERE id = ? AND evening_id = ?')
    .run(req.params.timeslotId, req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Timeslot not found' }); return; }
  res.json({ success: true });
});

// ===== Schedule Generation =====

// Generate schedule for an evening: allocate students with lowest attended sessions
router.post('/:id/generate-schedule', (req: Request, res: Response) => {
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id) as any;
  if (!evening) { res.status(404).json({ error: 'Training evening not found' }); return; }

  const instructorCount = (db.prepare('SELECT COUNT(*) AS cnt FROM evening_instructors WHERE evening_id = ?')
    .get(req.params.id) as any).cnt;
  if (instructorCount === 0) { res.status(400).json({ error: 'No instructors assigned for this evening' }); return; }

  const timeslots = db.prepare('SELECT * FROM timeslots WHERE evening_id = ? ORDER BY start_time ASC')
    .all(req.params.id) as any[];
  if (timeslots.length === 0) { res.status(400).json({ error: 'No timeslots defined for this evening' }); return; }

  // Each timeslot has one spot per instructor
  const totalSlots = timeslots.length * instructorCount;

  // Remove existing invitations for this evening
  db.prepare('DELETE FROM invitations WHERE evening_id = ?').run(req.params.id);

  // Get active students ordered by attended sessions (lowest first), then by name
  const students = db.prepare(`
    SELECT s.* FROM students s
    WHERE s.active = 1
      AND s.id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_evenings te ON te.id = inv.evening_id
        WHERE te.date = ? AND inv.status != 'declined'
      )
    ORDER BY s.attended_sessions ASC, s.last_name ASC, s.first_name ASC
  `).all(evening.date) as any[];

  const insertInvitation = db.prepare(`
    INSERT INTO invitations (evening_id, student_id, timeslot_id, instructor_id, token)
    VALUES (?, ?, ?, ?, ?)
  `);

  const instructors = db.prepare(`
    SELECT i.id FROM instructors i
    JOIN evening_instructors ei ON ei.instructor_id = i.id
    WHERE ei.evening_id = ?
    ORDER BY i.last_name ASC, i.first_name ASC
  `).all(req.params.id) as any[];

  const insertMany = db.transaction((studentsArr: any[], eveningId: string | string[], slots: any[]) => {
    const invited: any[] = [];
    let studentIdx = 0;
    // Fill timeslots: for each timeslot, assign one student per instructor
    for (const timeslot of slots) {
      for (const instructor of instructors) {
        if (studentIdx >= studentsArr.length) break;
        const token = crypto.randomUUID();
        insertInvitation.run(eveningId, studentsArr[studentIdx].id, timeslot.id, instructor.id, token);
        invited.push({ ...studentsArr[studentIdx], token, timeslot_id: timeslot.id, instructor_id: instructor.id, start_time: timeslot.start_time });
        studentIdx++;
      }
      if (studentIdx >= studentsArr.length) break;
    }
    return invited;
  });

  const invited = insertMany(students, req.params.id, timeslots);

  // Update evening status to scheduled
  db.prepare("UPDATE training_evenings SET status = 'scheduled' WHERE id = ?").run(req.params.id);

  res.json({
    evening_id: req.params.id,
    total_slots: totalSlots,
    students_invited: invited.length,
    invitations: invited,
  });
});

// ===== Send Invitation Emails =====

router.post('/:id/send-invitations', async (req: Request, res: Response) => {
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id) as any;
  if (!evening) { res.status(404).json({ error: 'Training evening not found' }); return; }

  const invitations = db.prepare(`
    SELECT inv.*, s.first_name || ' ' || s.last_name AS student_name, s.email AS student_email
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    WHERE inv.evening_id = ? AND inv.email_sent = 0 AND inv.status = 'scheduled'
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
        date: evening.date,
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

  // Update evening status to invitations_sent
  if (sent > 0) {
    db.prepare("UPDATE training_evenings SET status = 'invitations_sent' WHERE id = ?").run(req.params.id);
  }

  res.json({ sent, errors });
});

// ===== Mark evening as completed and increment attended_sessions =====

router.post('/:id/complete', (req: Request, res: Response) => {
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id) as any;
  if (!evening) { res.status(404).json({ error: 'Training evening not found' }); return; }
  if (evening.status === 'completed') { res.status(400).json({ error: 'Evening already completed' }); return; }

  const confirmedStudents = db.prepare(`
    SELECT student_id FROM invitations
    WHERE evening_id = ? AND status = 'confirmed'
  `).all(req.params.id) as Array<{ student_id: number }>;

  const updateAttended = db.prepare('UPDATE students SET attended_sessions = attended_sessions + 1 WHERE id = ?');
  const completeTransaction = db.transaction(() => {
    for (const { student_id } of confirmedStudents) {
      updateAttended.run(student_id);
    }
    db.prepare("UPDATE training_evenings SET status = 'completed' WHERE id = ?").run(req.params.id);
  });

  completeTransaction();
  res.json({ success: true, students_credited: confirmedStudents.length });
});

export default router;
