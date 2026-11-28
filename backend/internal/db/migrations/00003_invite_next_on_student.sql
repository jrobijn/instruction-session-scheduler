-- "Invite next" is an override of the student's place in the queue, like their cooldown, so it
-- moves from their group membership to the student: it now survives a change of group.

-- +goose Up
ALTER TABLE students ADD COLUMN invite_next_at TEXT;
UPDATE students SET invite_next_at = (
  SELECT sg.invite_next_at FROM student_groups sg WHERE sg.student_id = students.id
);
ALTER TABLE student_groups DROP COLUMN invite_next_at;

-- +goose Down
ALTER TABLE student_groups ADD COLUMN invite_next_at TEXT;
UPDATE student_groups SET invite_next_at = (
  SELECT s.invite_next_at FROM students s WHERE s.id = student_groups.student_id
);
ALTER TABLE students DROP COLUMN invite_next_at;
