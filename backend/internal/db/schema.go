package db

// schema is the end state of database.ts after all of its migrations have run.
const schema = `
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  membership_id TEXT NOT NULL DEFAULT '',
  attended_sessions INTEGER NOT NULL DEFAULT 0,
  no_show_count INTEGER NOT NULL DEFAULT 0,
  preferred_days TEXT NOT NULL DEFAULT '0|1|2|3|4|5|6',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cooldown_until TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS timetables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','saved')),
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  day_of_week INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','invitations_sent','completed','cancelled')),
  timetable_id INTEGER REFERENCES timetables(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, instructor_id)
);

CREATE TABLE IF NOT EXISTS disciplines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  abbreviation TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timeslots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,
  UNIQUE(timetable_id, start_time)
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  new_member_priority TEXT NOT NULL DEFAULT 'back',
  reactivated_member_priority TEXT NOT NULL DEFAULT 'back',
  cooldown_member_priority TEXT NOT NULL DEFAULT 'back'
);

CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  timeslot_id INTEGER NOT NULL REFERENCES timeslots(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES session_slots(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','invited','confirmed','declined','expired','invalidated','cancelled','admin_cancelled')),
  discipline_id INTEGER REFERENCES disciplines(id) ON DELETE SET NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  email_sent INTEGER NOT NULL DEFAULT 0,
  no_show INTEGER NOT NULL DEFAULT 0,
  invited_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  decision_log TEXT
);

CREATE TABLE IF NOT EXISTS student_preferred_timeslots (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  timeslot_id INTEGER NOT NULL REFERENCES timeslots(id) ON DELETE CASCADE,
  timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  PRIMARY KEY(student_id, timeslot_id)
);

CREATE TABLE IF NOT EXISTS student_groups (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  joined_at TEXT,
  reactivated_at TEXT,
  invite_next_at TEXT,
  PRIMARY KEY(student_id, group_id),
  UNIQUE(student_id)
);

CREATE TABLE IF NOT EXISTS timetable_groups (
  timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  percentage INTEGER NOT NULL DEFAULT 100,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(timetable_id, group_id)
);

CREATE TABLE IF NOT EXISTS discipline_groups (
  discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY(discipline_id, group_id)
);

CREATE TABLE IF NOT EXISTS buddy_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buddy_group_members (
  buddy_group_id INTEGER NOT NULL REFERENCES buddy_groups(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY(buddy_group_id, student_id),
  UNIQUE(student_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('invitation_confirmed','invitation_declined','invitation_expired','invitation_cancelled','session_full','session_no_longer_full')),
  invitation_id INTEGER REFERENCES invitations(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES training_sessions(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL DEFAULT '',
  session_date TEXT NOT NULL,
  timeslot_start_time TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('club_name', 'Sports Club');
INSERT OR IGNORE INTO settings (key, value) VALUES ('club_days', '0|1|2|3|4|5|6');
INSERT OR IGNORE INTO settings (key, value) VALUES ('invitation_expiry_minutes', '120');
INSERT OR IGNORE INTO settings (key, value) VALUES ('invitation_check_interval_minutes', '15');
INSERT OR IGNORE INTO settings (key, value) VALUES ('email_locale', 'en');
INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'Europe/Amsterdam');
`
