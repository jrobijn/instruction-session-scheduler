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

    CREATE TABLE IF NOT EXISTS training_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','invitations_sent','completed')),
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
      session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
      start_time TEXT NOT NULL,
      UNIQUE(session_id, start_time)
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
      email_sent INTEGER NOT NULL DEFAULT 0,
      no_show INTEGER NOT NULL DEFAULT 0,
      invited_at TEXT NOT NULL DEFAULT (datetime('now')),
      responded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Default settings
    INSERT OR IGNORE INTO settings (key, value) VALUES ('club_name', 'Sports Club');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('invitation_email_subject', 'You are invited to a coaching session!');
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
}

export default db;
