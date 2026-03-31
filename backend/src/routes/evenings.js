import { Router } from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { sendInvitationEmail } from '../email.js';

const router = Router();

// List all training evenings
router.get('/', (req, res) => {
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
router.get('/:id', (req, res) => {
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) return res.status(404).json({ error: 'Training evening not found' });

  const instructors = db.prepare(`
    SELECT i.* FROM instructors i
    JOIN evening_instructors ei ON ei.instructor_id = i.id
    WHERE ei.evening_id = ?
    ORDER BY i.name
  `).all(req.params.id);

  const invitations = db.prepare(`
    SELECT inv.*, s.name AS student_name, s.email AS student_email, s.attended_sessions,
           d.name AS discipline_name
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    LEFT JOIN disciplines d ON d.id = inv.discipline_id
    WHERE inv.evening_id = ?
    ORDER BY inv.slot_number ASC
  `).all(req.params.id);

  res.json({ ...evening, instructors, invitations });
});

// Create training evening
router.post('/', (req, res) => {
  const { date, notes } = req.body;
  if (!date) return res.status(400).json({ error: 'Date is required' });

  try {
    const result = db.prepare('INSERT INTO training_evenings (date, notes) VALUES (?, ?)').run(date, notes || null);
    const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(evening);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A training evening already exists for this date' });
    }
    throw err;
  }
});

// Update training evening
router.put('/:id', (req, res) => {
  const { date, notes, status } = req.body;
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) return res.status(404).json({ error: 'Training evening not found' });

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
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM training_evenings WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Training evening not found' });
  res.json({ success: true });
});

// ===== Instructor Assignment =====

// Assign instructor to evening
router.post('/:id/instructors', (req, res) => {
  const { instructor_id } = req.body;
  if (!instructor_id) return res.status(400).json({ error: 'instructor_id is required' });

  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) return res.status(404).json({ error: 'Training evening not found' });

  try {
    db.prepare('INSERT INTO evening_instructors (evening_id, instructor_id) VALUES (?, ?)').run(req.params.id, instructor_id);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Instructor already assigned to this evening' });
    }
    if (err.message.includes('FOREIGN KEY')) {
      return res.status(400).json({ error: 'Invalid instructor' });
    }
    throw err;
  }
});

// Remove instructor from evening
router.delete('/:id/instructors/:instructorId', (req, res) => {
  const result = db.prepare('DELETE FROM evening_instructors WHERE evening_id = ? AND instructor_id = ?')
    .run(req.params.id, req.params.instructorId);
  if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found' });
  res.json({ success: true });
});

// ===== Schedule Generation =====

// Generate schedule for an evening: allocate students with lowest attended sessions
router.post('/:id/generate-schedule', (req, res) => {
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) return res.status(404).json({ error: 'Training evening not found' });

  const instructorCount = db.prepare('SELECT COUNT(*) AS cnt FROM evening_instructors WHERE evening_id = ?')
    .get(req.params.id).cnt;
  if (instructorCount === 0) return res.status(400).json({ error: 'No instructors assigned for this evening' });

  const sessionsPerInstructor = parseInt(
    db.prepare("SELECT value FROM settings WHERE key = 'sessions_per_instructor'").get()?.value || '3'
  );
  const totalSlots = instructorCount * sessionsPerInstructor;

  // Remove existing invitations for this evening
  db.prepare('DELETE FROM invitations WHERE evening_id = ?').run(req.params.id);

  // Get active students ordered by attended sessions (lowest first), then by name
  // Exclude students already invited to other evenings on the same date that haven't declined
  const students = db.prepare(`
    SELECT s.* FROM students s
    WHERE s.active = 1
      AND s.id NOT IN (
        SELECT inv.student_id FROM invitations inv
        JOIN training_evenings te ON te.id = inv.evening_id
        WHERE te.date = ? AND inv.status != 'declined'
      )
    ORDER BY s.attended_sessions ASC, s.name ASC
  `).all(evening.date);

  const insertInvitation = db.prepare(`
    INSERT INTO invitations (evening_id, student_id, token, slot_number)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db.transaction((students, eveningId, totalSlots) => {
    const invited = [];
    for (let i = 0; i < Math.min(totalSlots, students.length); i++) {
      const token = crypto.randomUUID();
      insertInvitation.run(eveningId, students[i].id, token, i + 1);
      invited.push({ ...students[i], token, slot_number: i + 1 });
    }
    return invited;
  });

  const invited = insertMany(students, req.params.id, totalSlots);

  // Update evening status to published
  db.prepare("UPDATE training_evenings SET status = 'published' WHERE id = ?").run(req.params.id);

  res.json({
    evening_id: req.params.id,
    total_slots: totalSlots,
    students_invited: invited.length,
    invitations: invited,
  });
});

// ===== Send Invitation Emails =====

router.post('/:id/send-invitations', async (req, res) => {
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) return res.status(404).json({ error: 'Training evening not found' });

  const invitations = db.prepare(`
    SELECT inv.*, s.name AS student_name, s.email AS student_email
    FROM invitations inv
    JOIN students s ON s.id = inv.student_id
    WHERE inv.evening_id = ? AND inv.email_sent = 0 AND inv.status = 'invited'
  `).all(req.params.id);

  if (invitations.length === 0) {
    return res.json({ message: 'No pending invitations to send', sent: 0 });
  }

  const clubName = db.prepare("SELECT value FROM settings WHERE key = 'club_name'").get()?.value || 'Sports Club';
  const subject = db.prepare("SELECT value FROM settings WHERE key = 'invitation_email_subject'").get()?.value
    || 'You are invited to a coaching session!';

  let sent = 0;
  const errors = [];

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
      db.prepare('UPDATE invitations SET email_sent = 1 WHERE id = ?').run(inv.id);
      sent++;
    } catch (err) {
      errors.push({ student: inv.student_name, error: err.message });
    }
  }

  res.json({ sent, errors });
});

// ===== Mark evening as completed and increment attended_sessions =====

router.post('/:id/complete', (req, res) => {
  const evening = db.prepare('SELECT * FROM training_evenings WHERE id = ?').get(req.params.id);
  if (!evening) return res.status(404).json({ error: 'Training evening not found' });
  if (evening.status === 'completed') return res.status(400).json({ error: 'Evening already completed' });

  const confirmedStudents = db.prepare(`
    SELECT student_id FROM invitations
    WHERE evening_id = ? AND status = 'confirmed'
  `).all(req.params.id);

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
