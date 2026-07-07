import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');

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
      membership_id TEXT NOT NULL DEFAULT '',
      attended_sessions INTEGER NOT NULL DEFAULT 0,
      no_show_count INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 1,
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

    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      timeslot_id INTEGER NOT NULL REFERENCES timeslots(id) ON DELETE CASCADE,
      slot_id INTEGER NOT NULL REFERENCES session_slots(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','invited','confirmed','declined','expired','cancelled','admin_cancelled')),
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
      color TEXT NOT NULL DEFAULT '#3b82f6',
      is_default INTEGER NOT NULL DEFAULT 0,
      new_member_priority TEXT NOT NULL DEFAULT 'lowest',
      reactivated_member_priority TEXT NOT NULL DEFAULT 'lowest',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS student_groups (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      priority INTEGER,
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

    -- Default settings
    INSERT OR IGNORE INTO settings (key, value) VALUES ('club_name', 'Sports Club');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('club_days', '0|1|2|3|4|5|6');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('invitation_expiry_minutes', '120');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('invitation_check_interval_minutes', '15');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('email_locale', 'en');
  `);

  // Migrations for existing databases

  // Rename evenings -> sessions tables and columns
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  if (tables.some(t => t.name === 'training_evenings')) {
    db.exec('ALTER TABLE training_evenings RENAME TO training_sessions');
  }
  if (tables.some(t => t.name === 'evening_instructors')) {
    db.exec('ALTER TABLE evening_instructors RENAME TO session_slots');
  }
  // Rename evening_id columns
  const sessionInstrCols = db.prepare("PRAGMA table_info(session_slots)").all() as Array<{ name: string }>;
  if (sessionInstrCols.some(c => c.name === 'evening_id')) {
    db.exec('ALTER TABLE session_slots RENAME COLUMN evening_id TO session_id');
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

  // Add membership_id column to students if missing
  const studentColsMid = db.prepare("PRAGMA table_info(students)").all() as Array<{ name: string }>;
  if (!studentColsMid.some(c => c.name === 'membership_id')) {
    db.exec("ALTER TABLE students ADD COLUMN membership_id TEXT NOT NULL DEFAULT ''");
  }

  // Add abbreviation column to disciplines if missing
  const discCols = db.prepare("PRAGMA table_info(disciplines)").all() as Array<{ name: string }>;
  if (!discCols.some(c => c.name === 'abbreviation')) {
    db.exec("ALTER TABLE disciplines ADD COLUMN abbreviation TEXT NOT NULL DEFAULT ''");
  }



  // Migrate invitations CHECK constraint to include 'expired' and 'cancelled' statuses
  const checkInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='invitations'").get() as { sql: string } | undefined;
  if (checkInfo && !checkInfo.sql.includes("'admin_cancelled'")) {
    db.exec(`
      CREATE TABLE invitations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        timeslot_id INTEGER NOT NULL REFERENCES timeslots(id) ON DELETE CASCADE,
        instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','invited','confirmed','declined','expired','cancelled','admin_cancelled')),
        discipline_id INTEGER REFERENCES disciplines(id) ON DELETE SET NULL,
        group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        email_sent INTEGER NOT NULL DEFAULT 0,
        no_show INTEGER NOT NULL DEFAULT 0,
        invited_at TEXT NOT NULL DEFAULT (datetime('now')),
        responded_at TEXT
      );
      INSERT INTO invitations_new SELECT * FROM invitations;
      DROP TABLE invitations;
      ALTER TABLE invitations_new RENAME TO invitations;
    `);
  }

  // Migrate session_instructors -> session_slots and invitations.instructor_id -> invitations.slot_id
  const tablesNow = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  if (tablesNow.some(t => t.name === 'session_instructors')) {
    if (tablesNow.some(t => t.name === 'session_slots')) {
      // Both tables exist (e.g. schema created session_slots while old session_instructors still around)
      // Merge any data from session_instructors into session_slots, then drop the old table
      db.exec(`INSERT OR IGNORE INTO session_slots (session_id, instructor_id) SELECT session_id, instructor_id FROM session_instructors`);
      db.exec('DROP TABLE session_instructors');
    } else {
      db.exec('ALTER TABLE session_instructors RENAME TO session_slots');
    }
  }
  const invColsSlot = db.prepare("PRAGMA table_info(invitations)").all() as Array<{ name: string }>;
  if (invColsSlot.some(c => c.name === 'instructor_id') && !invColsSlot.some(c => c.name === 'slot_id')) {
    db.pragma('foreign_keys = OFF');
    // Add slot_id, populate from session_slots, then rebuild without instructor_id
    db.exec(`ALTER TABLE invitations ADD COLUMN slot_id INTEGER REFERENCES session_slots(id) ON DELETE CASCADE`);
    db.exec(`
      UPDATE invitations SET slot_id = (
        SELECT ss.id FROM session_slots ss
        WHERE ss.session_id = invitations.session_id AND ss.instructor_id = invitations.instructor_id
      )
    `);
    // For any orphaned invitations (instructor removed), create session_slots entries
    const orphans = db.prepare(`
      SELECT DISTINCT session_id, instructor_id FROM invitations WHERE slot_id IS NULL
    `).all() as Array<{ session_id: number; instructor_id: number }>;
    for (const orphan of orphans) {
      db.prepare('INSERT OR IGNORE INTO session_slots (session_id, instructor_id) VALUES (?, ?)').run(orphan.session_id, orphan.instructor_id);
    }
    if (orphans.length > 0) {
      db.exec(`
        UPDATE invitations SET slot_id = (
          SELECT ss.id FROM session_slots ss
          WHERE ss.session_id = invitations.session_id AND ss.instructor_id = invitations.instructor_id
        ) WHERE slot_id IS NULL
      `);
    }
    // Rebuild invitations table without instructor_id
    db.exec(`
      CREATE TABLE invitations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        timeslot_id INTEGER NOT NULL REFERENCES timeslots(id) ON DELETE CASCADE,
        slot_id INTEGER NOT NULL REFERENCES session_slots(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','invited','confirmed','declined','expired','cancelled','admin_cancelled')),
        discipline_id INTEGER REFERENCES disciplines(id) ON DELETE SET NULL,
        group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        email_sent INTEGER NOT NULL DEFAULT 0,
        no_show INTEGER NOT NULL DEFAULT 0,
        invited_at TEXT NOT NULL DEFAULT (datetime('now')),
        responded_at TEXT
      );
      INSERT INTO invitations_new (id, session_id, student_id, timeslot_id, slot_id, token, status, discipline_id, group_id, email_sent, no_show, invited_at, responded_at)
        SELECT id, session_id, student_id, timeslot_id, slot_id, token, status, discipline_id, group_id, email_sent, no_show, invited_at, responded_at FROM invitations;
      DROP TABLE invitations;
      ALTER TABLE invitations_new RENAME TO invitations;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Add cooldown_until column to students if missing
  const studentCols3 = db.prepare("PRAGMA table_info(students)").all() as Array<{ name: string }>;
  if (!studentCols3.some(c => c.name === 'cooldown_until')) {
    db.exec('ALTER TABLE students ADD COLUMN cooldown_until TEXT');
  }

  // Add priority column to students if missing
  const studentCols4 = db.prepare("PRAGMA table_info(students)").all() as Array<{ name: string }>;
  if (!studentCols4.some(c => c.name === 'priority')) {
    db.exec('ALTER TABLE students ADD COLUMN priority INTEGER NOT NULL DEFAULT 1');
    // Backfill: set priority = attended_sessions + 1, then normalize so min = 1
    db.exec('UPDATE students SET priority = attended_sessions + 1');
    const minP = (db.prepare('SELECT MIN(priority) AS m FROM students').get() as any)?.m || 1;
    if (minP > 1) {
      db.exec(`UPDATE students SET priority = priority - ${minP - 1}`);
    }
  }
  // Add removed column to session_slots if missing
  const slotCols = db.prepare("PRAGMA table_info(session_slots)").all() as Array<{ name: string }>;
  if (!slotCols.some(c => c.name === 'removed')) {
    db.exec('ALTER TABLE session_slots ADD COLUMN removed INTEGER NOT NULL DEFAULT 0');
  }

  // Migrate training_sessions CHECK constraint to include 'cancelled' status
  const sessCheckInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='training_sessions'").get() as { sql: string } | undefined;
  if (sessCheckInfo && !sessCheckInfo.sql.includes("'cancelled'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE training_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        day_of_week INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','invitations_sent','completed','cancelled')),
        timetable_id INTEGER REFERENCES timetables(id) ON DELETE SET NULL,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO training_sessions_new SELECT * FROM training_sessions;
      DROP TABLE training_sessions;
      ALTER TABLE training_sessions_new RENAME TO training_sessions;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Migrate to single group per student: keep only the highest-priority group membership
  const sgSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='student_groups'").get() as { sql: string } | undefined;
  if (sgSchema && !sgSchema.sql.includes('UNIQUE(student_id)')) {
    db.pragma('foreign_keys = OFF');
    // For each student with multiple groups, keep only the one with the lowest priority number
    db.exec(`
      DELETE FROM student_groups WHERE rowid NOT IN (
        SELECT sg.rowid FROM student_groups sg
        JOIN groups g ON g.id = sg.group_id
        WHERE sg.student_id || '-' || g.priority = (
          SELECT sg2.student_id || '-' || MIN(g2.priority)
          FROM student_groups sg2
          JOIN groups g2 ON g2.id = sg2.group_id
          WHERE sg2.student_id = sg.student_id
        )
      )
    `);
    // Rebuild table with UNIQUE constraint on student_id
    db.exec(`
      CREATE TABLE student_groups_new (
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        PRIMARY KEY(student_id, group_id),
        UNIQUE(student_id)
      );
      INSERT INTO student_groups_new SELECT * FROM student_groups;
      DROP TABLE student_groups;
      ALTER TABLE student_groups_new RENAME TO student_groups;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Remove priority column from groups if present
  const groupsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='groups'").get() as { sql: string } | undefined;
  if (groupsSchema && groupsSchema.sql.includes('priority')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE groups_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#3b82f6',
        is_default INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO groups_new (id, name, color, is_default, active, created_at)
        SELECT id, name, color, is_default, active, created_at FROM groups;
      DROP TABLE groups;
      ALTER TABLE groups_new RENAME TO groups;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Add position column to timetable_groups if missing
  const tgSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='timetable_groups'").get() as { sql: string } | undefined;
  if (tgSchema && !tgSchema.sql.includes('position')) {
    db.exec(`ALTER TABLE timetable_groups ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
    // Set positions based on existing rowid order per timetable
    const timetables = db.prepare('SELECT DISTINCT timetable_id FROM timetable_groups').all() as Array<{ timetable_id: number }>;
    for (const tt of timetables) {
      const rows = db.prepare('SELECT rowid, group_id FROM timetable_groups WHERE timetable_id = ? ORDER BY rowid ASC').all(tt.timetable_id) as Array<{ rowid: number; group_id: number }>;
      rows.forEach((row, idx) => {
        db.prepare('UPDATE timetable_groups SET position = ? WHERE timetable_id = ? AND group_id = ?').run(idx, tt.timetable_id, row.group_id);
      });
    }
  }

  // Remove name column from buddy_groups if present
  const bgSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='buddy_groups'").get() as { sql: string } | undefined;
  if (bgSchema && bgSchema.sql.includes('name')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE buddy_groups_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO buddy_groups_new (id, created_at) SELECT id, created_at FROM buddy_groups;
      DROP TABLE buddy_groups;
      ALTER TABLE buddy_groups_new RENAME TO buddy_groups;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Add deleted_at column to students if missing
  const studentCols5 = db.prepare("PRAGMA table_info(students)").all() as Array<{ name: string }>;
  if (!studentCols5.some(c => c.name === 'deleted_at')) {
    db.exec('ALTER TABLE students ADD COLUMN deleted_at TEXT');
  }

  // Add deleted_at column to instructors if missing
  const instructorCols = db.prepare("PRAGMA table_info(instructors)").all() as Array<{ name: string }>;
  if (!instructorCols.some(c => c.name === 'deleted_at')) {
    db.exec('ALTER TABLE instructors ADD COLUMN deleted_at TEXT');
  }

  // Add decision_log column to invitations if missing
  const invColsDecLog = db.prepare("PRAGMA table_info(invitations)").all() as Array<{ name: string }>;
  if (!invColsDecLog.some(c => c.name === 'decision_log')) {
    db.exec('ALTER TABLE invitations ADD COLUMN decision_log TEXT');
  }

  // Add session_id column to notifications if missing
  const notifCols = db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>;
  if (notifCols.length > 0 && !notifCols.some(c => c.name === 'session_id')) {
    db.exec('ALTER TABLE notifications ADD COLUMN session_id INTEGER REFERENCES training_sessions(id) ON DELETE CASCADE');
    // Backfill session_id from invitations
    db.exec(`
      UPDATE notifications SET session_id = (
        SELECT inv.session_id FROM invitations inv WHERE inv.id = notifications.invitation_id
      ) WHERE session_id IS NULL AND invitation_id IS NOT NULL
    `);
  }

  // Migrate priority from global (students.priority) to per-group (student_groups.priority)
  const sgPriorityCols = db.prepare("PRAGMA table_info(student_groups)").all() as Array<{ name: string }>;
  if (!sgPriorityCols.some(c => c.name === 'priority')) {
    db.exec('ALTER TABLE student_groups ADD COLUMN priority INTEGER NOT NULL DEFAULT 1');
    // Backfill from the old global students.priority using DENSE_RANK per group so each
    // group gets gapless 1..n values while preserving relative order and existing ties.
    const studentsHavePriority = (db.prepare("PRAGMA table_info(students)").all() as Array<{ name: string }>)
      .some(c => c.name === 'priority');
    if (studentsHavePriority) {
      db.exec(`
        WITH ranked AS (
          SELECT sg.student_id,
                 DENSE_RANK() OVER (PARTITION BY sg.group_id ORDER BY s.priority) AS new_priority
          FROM student_groups sg
          JOIN students s ON s.id = sg.student_id
        )
        UPDATE student_groups
        SET priority = (SELECT new_priority FROM ranked WHERE ranked.student_id = student_groups.student_id)
        WHERE student_id IN (SELECT student_id FROM ranked)
      `);
    }
  }

  // Add new_member_priority column to groups if missing (controls how a new member's
  // priority is assigned: 'highest' = priority 1 (existing members pushed back), or
  // 'lowest' = MAX(priority) + 1 (new member goes after all existing members).
  const groupNewMemberCols = db.prepare("PRAGMA table_info(groups)").all() as Array<{ name: string }>;
  if (!groupNewMemberCols.some(c => c.name === 'new_member_priority')) {
    db.exec("ALTER TABLE groups ADD COLUMN new_member_priority TEXT NOT NULL DEFAULT 'lowest'");
  }

  // Add reactivated_member_priority column to groups if missing (controls how a
  // student's priority is assigned when they become active again, independent of
  // new members — same options: 'highest' | 'lowest' | 'average').
  const groupReactivatedCols = db.prepare("PRAGMA table_info(groups)").all() as Array<{ name: string }>;
  if (!groupReactivatedCols.some(c => c.name === 'reactivated_member_priority')) {
    db.exec("ALTER TABLE groups ADD COLUMN reactivated_member_priority TEXT NOT NULL DEFAULT 'lowest'");
  }

  // Make student_groups.priority nullable: inactive students are un-ranked (NULL) and
  // re-enter the queue on reactivation. SQLite cannot drop NOT NULL via ALTER, so rebuild
  // the table when the existing column is still NOT NULL.
  const studentGroupCols = db.prepare("PRAGMA table_info(student_groups)").all() as Array<{ name: string; notnull: number }>;
  const sgPriorityCol = studentGroupCols.find(c => c.name === 'priority');
  if (sgPriorityCol && sgPriorityCol.notnull === 1) {
    db.exec(`
      CREATE TABLE student_groups_new (
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        priority INTEGER,
        PRIMARY KEY(student_id, group_id),
        UNIQUE(student_id)
      );
      INSERT INTO student_groups_new (student_id, group_id, priority)
        SELECT student_id, group_id, priority FROM student_groups;
      DROP TABLE student_groups;
      ALTER TABLE student_groups_new RENAME TO student_groups;
    `);
    // Un-rank students that are already inactive.
    db.exec(`
      UPDATE student_groups SET priority = NULL
      WHERE student_id IN (SELECT id FROM students WHERE active = 0)
    `);
  }

  // Migrate notifications CHECK constraint to include new types
  const notifSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get() as { sql: string } | undefined;
  if (notifSchema && !notifSchema.sql.includes("'session_full'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE notifications_new (
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
      INSERT INTO notifications_new (id, type, invitation_id, session_id, student_name, session_date, timeslot_start_time, read, created_at)
        SELECT id, type, invitation_id, session_id, student_name, session_date, timeslot_start_time, read, created_at FROM notifications;
      DROP TABLE notifications;
      ALTER TABLE notifications_new RENAME TO notifications;
    `);
    db.pragma('foreign_keys = ON');
  }
}

export default db;
