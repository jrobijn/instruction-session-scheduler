import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data.db');

const db: DatabaseType = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      attended_sessions INTEGER NOT NULL DEFAULT 0,
      no_show_count INTEGER NOT NULL DEFAULT 0,
      preferred_days TEXT NOT NULL DEFAULT '0|1|2|3|4|5|6',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instructors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','invitations_sent','completed')),
      timetable_id INTEGER REFERENCES timetables(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_instructors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
      instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
      UNIQUE(session_id, instructor_id)
    );

    CREATE TABLE IF NOT EXISTS disciplines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS timeslots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
      start_time TEXT NOT NULL,
      UNIQUE(timetable_id, start_time)
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      timeslot_id INTEGER NOT NULL REFERENCES timeslots(id) ON DELETE CASCADE,
      instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','invited','confirmed','declined')),
      discipline_id INTEGER REFERENCES disciplines(id) ON DELETE SET NULL,
      group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      email_sent INTEGER NOT NULL DEFAULT 0,
      no_show INTEGER NOT NULL DEFAULT 0,
      invited_at TEXT NOT NULL DEFAULT (datetime('now')),
      responded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS student_preferred_timeslots (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      timeslot_id INTEGER NOT NULL REFERENCES timeslots(id) ON DELETE CASCADE,
      timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
      PRIMARY KEY(student_id, timeslot_id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      priority INTEGER NOT NULL DEFAULT 9999 UNIQUE,
      color TEXT NOT NULL DEFAULT '#3b82f6',
      is_default INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS student_groups (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY(student_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS timetable_groups (
      timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      percentage INTEGER NOT NULL DEFAULT 100,
      PRIMARY KEY(timetable_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS discipline_groups (
      discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY(discipline_id, group_id)
    );

    -- Default group (all students belong to this)
    INSERT OR IGNORE INTO groups (name, priority, is_default, color) VALUES ('Default', 10000, 1, '#565656');

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Default settings
    INSERT OR IGNORE INTO settings (key, value) VALUES ('club_name', 'Sports Club');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('invitation_email_subject', 'You are invited to a coaching session!');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('club_days', '0|1|2|3|4|5|6');
  `);

  // Migrations for existing databases

  // Rename evenings -> sessions tables and columns
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  if (tables.some(t => t.name === 'training_evenings')) {
    db.exec('ALTER TABLE training_evenings RENAME TO training_sessions');
  }
  if (tables.some(t => t.name === 'evening_instructors')) {
    db.exec('ALTER TABLE evening_instructors RENAME TO session_instructors');
  }
  // Rename evening_id columns
  const sessionInstrCols = db.prepare("PRAGMA table_info(session_instructors)").all() as Array<{ name: string }>;
  if (sessionInstrCols.some(c => c.name === 'evening_id')) {
    db.exec('ALTER TABLE session_instructors RENAME COLUMN evening_id TO session_id');
  }
  const timeslotCols = db.prepare("PRAGMA table_info(timeslots)").all() as Array<{ name: string }>;
  if (timeslotCols.some(c => c.name === 'evening_id')) {
    db.exec('ALTER TABLE timeslots RENAME COLUMN evening_id TO session_id');
  }
  const invitationCols2 = db.prepare("PRAGMA table_info(invitations)").all() as Array<{ name: string }>;
  if (invitationCols2.some(c => c.name === 'evening_id')) {
    db.exec('ALTER TABLE invitations RENAME COLUMN evening_id TO session_id');
  }

  const studentCols = db.prepare("PRAGMA table_info(students)").all() as Array<{ name: string }>;
  if (!studentCols.some(c => c.name === 'no_show_count')) {
    db.exec('ALTER TABLE students ADD COLUMN no_show_count INTEGER NOT NULL DEFAULT 0');
  }

  const invitationCols = db.prepare("PRAGMA table_info(invitations)").all() as Array<{ name: string }>;
  if (!invitationCols.some(c => c.name === 'no_show')) {
    db.exec('ALTER TABLE invitations ADD COLUMN no_show INTEGER NOT NULL DEFAULT 0');
  }

  // Migrate timeslots from session-based to timetable-based
  const tsCols = db.prepare("PRAGMA table_info(timeslots)").all() as Array<{ name: string }>;
  if (tsCols.some(c => c.name === 'session_id')) {
    if (!tsCols.some(c => c.name === 'timetable_id')) {
      db.exec('ALTER TABLE timeslots ADD COLUMN timetable_id INTEGER REFERENCES timetables(id) ON DELETE CASCADE');
    }

    const sessionsWithTimeslots = db.prepare(
      'SELECT DISTINCT t.session_id, ts.date FROM timeslots t JOIN training_sessions ts ON ts.id = t.session_id WHERE t.session_id IS NOT NULL AND t.timetable_id IS NULL'
    ).all() as Array<{ session_id: number; date: string }>;

    for (const { session_id, date } of sessionsWithTimeslots) {
      const result = db.prepare(
        "INSERT INTO timetables (name, status, is_default, active) VALUES (?, 'saved', 0, 1)"
      ).run(`Session ${date}`);
      const timetableId = result.lastInsertRowid;
      db.prepare('UPDATE timeslots SET timetable_id = ? WHERE session_id = ?').run(timetableId, session_id);
      db.prepare('UPDATE training_sessions SET timetable_id = ? WHERE id = ?').run(timetableId, session_id);
    }

    const first = db.prepare('SELECT id FROM timetables WHERE active = 1 ORDER BY id ASC LIMIT 1').get() as any;
    if (first) {
      db.prepare('UPDATE timetables SET is_default = 1 WHERE id = ?').run(first.id);
    }
  }

  // Add timetable_id to training_sessions if missing
  const sessCols = db.prepare("PRAGMA table_info(training_sessions)").all() as Array<{ name: string }>;
  if (!sessCols.some(c => c.name === 'timetable_id')) {
    db.exec('ALTER TABLE training_sessions ADD COLUMN timetable_id INTEGER REFERENCES timetables(id) ON DELETE SET NULL');
  }

  // Add preferred_days to students if missing
  const studentCols2 = db.prepare("PRAGMA table_info(students)").all() as Array<{ name: string }>;
  if (!studentCols2.some(c => c.name === 'preferred_days')) {
    db.exec("ALTER TABLE students ADD COLUMN preferred_days TEXT NOT NULL DEFAULT '0|1|2|3|4|5|6'");
  }

  // Migrate preferred_days and club_days from comma to pipe delimiter
  const sampleStudent = db.prepare("SELECT preferred_days FROM students LIMIT 1").get() as { preferred_days: string } | undefined;
  if (sampleStudent && sampleStudent.preferred_days.includes(',')) {
    db.exec("UPDATE students SET preferred_days = REPLACE(preferred_days, ',', '|')");
  }
  const clubDaysSetting = db.prepare("SELECT value FROM settings WHERE key = 'club_days'").get() as { value: string } | undefined;
  if (clubDaysSetting && clubDaysSetting.value.includes(',')) {
    db.exec("UPDATE settings SET value = REPLACE(value, ',', '|') WHERE key = 'club_days'");
  }

  // Add day_of_week to training_sessions if missing
  const sessCols2 = db.prepare("PRAGMA table_info(training_sessions)").all() as Array<{ name: string }>;
  if (!sessCols2.some(c => c.name === 'day_of_week')) {
    db.exec('ALTER TABLE training_sessions ADD COLUMN day_of_week INTEGER NOT NULL DEFAULT 0');
    // Backfill day_of_week from existing dates
    const sessions = db.prepare('SELECT id, date FROM training_sessions').all() as Array<{ id: number; date: string }>;
    const updateDow = db.prepare('UPDATE training_sessions SET day_of_week = ? WHERE id = ?');
    for (const s of sessions) {
      const dow = new Date(s.date + 'T00:00:00').getDay();
      updateDow.run(dow, s.id);
    }
  }

  // Ensure all students are members of the default group
  const defaultGroup = db.prepare("SELECT id FROM groups WHERE is_default = 1").get() as { id: number } | undefined;
  if (defaultGroup) {
    db.exec(`
      INSERT OR IGNORE INTO student_groups (student_id, group_id)
      SELECT id, ${defaultGroup.id} FROM students
    `);
  }

  // Add color column to groups if missing
  const groupCols = db.prepare("PRAGMA table_info(groups)").all() as Array<{ name: string }>;
  if (!groupCols.some(c => c.name === 'color')) {
    db.exec("ALTER TABLE groups ADD COLUMN color TEXT NOT NULL DEFAULT '#3b82f6'");
  }

  // Add group_id column to invitations if missing
  const invCols = db.prepare("PRAGMA table_info(invitations)").all() as Array<{ name: string }>;
  if (!invCols.some(c => c.name === 'group_id')) {
    db.exec('ALTER TABLE invitations ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL');
  }

  // Ensure default group has the correct color
  db.exec("UPDATE groups SET color = '#565656' WHERE is_default = 1 AND color IN ('#3b82f6', '#232323')");
}

export default db;
