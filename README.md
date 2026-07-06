# Instruction Session Scheduler

A web application for scheduling instruction sessions at a sports club. Features an admin panel for managing students, instructors, groups, timetables, and training sessions — with an automated scheduling algorithm that takes into account student priority, group allocation, preferred days and timeslots, buddy groups, cooldown periods, and discipline access.

## Features

- **Student Management**: Add, edit, activate/deactivate students; CSV import/export; preferred days and timeslot preferences; cooldown periods; membership IDs
- **Instructor Management**: Add, edit, activate/deactivate instructors; CSV import/export
- **Groups**: Organize students into groups with color coding. Each student belongs to one group. A default group can auto-assign new students.
- **Disciplines**: Define disciplines (e.g. swimming, tennis) with abbreviations. Control which groups have access to which disciplines.
- **Timetables**: Create reusable timetable templates with configurable timeslots and group percentage allocations (e.g. Group A: 60%, Group B: 40%). Mark a timetable as default for new sessions.
- **Buddy Groups**: Link 2+ students so they are always scheduled together at adjacent timeslots
- **Automatic Schedule Generation**: Priority-based algorithm that considers group allocation, preferred days/timeslots, buddy groups, cooldown periods, and discipline access (see [Scheduling Algorithm](#scheduling-algorithm) below)
- **Email Invitations**: Sends localized invitation emails (English/Dutch) with personal RSVP links
- **Student RSVP**: Students confirm or decline via a personal token-based link
- **Invitation Expiry**: Configurable expiry timer (default: 120 minutes) — expired invitations automatically trigger replacement
- **Auto-Replacement**: When a student declines or an invitation expires, the next eligible student is automatically invited and emailed
- **No-Show Tracking**: Mark students who were confirmed but didn't attend
- **Real-Time Notifications**: Server-Sent Events (SSE) push live updates to the admin UI — confirmations, declines, expirations, session-full alerts
- **Internationalization**: Full English and Dutch support for both admin UI and student-facing emails
- **Dark/Light Theme**: Configurable appearance with automatic system detection

## Quick Start

### 1. Backend

```bash
cd backend
cp .env.example .env     # Edit .env with your settings
npm install
npm run dev              # Starts on http://localhost:3001
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev              # Starts on http://localhost:5173
```

### 3. Login

Open http://localhost:5173 and log in with the password set in `backend/.env` (default: `changeme`).

## Configuration

### Environment Variables

Edit `backend/.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend port | `3001` |
| `FRONTEND_URL` | Frontend URL for CORS and email links | `http://localhost:5173` |
| `ADMIN_PASSWORD` | Password for admin login | *(required)* |
| `JWT_SECRET` | JWT signing key | Falls back to `ADMIN_PASSWORD` |
| `DB_PATH` | SQLite database file path | `./data.db` |
| `SMTP_HOST` | SMTP server for sending emails | — |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_SECURE` | Use TLS (true/false) | `false` |
| `SMTP_USER` | SMTP username | — |
| `SMTP_PASS` | SMTP password | — |
| `SMTP_FROM` | From address for emails | — |

### In-App Settings

Configurable via the Settings page:

| Setting | Description | Default |
|---------|-------------|---------|
| **Club Name** | Shown in emails and the invitation page | `Sports Club` |
| **Club Days** | Which days of the week the club operates (pipe-delimited) | `0\|1\|2\|3\|4\|5\|6` |
| **Invitation Expiry Minutes** | How long invitations remain valid before auto-expiring; `0` = never | `120` |
| **Invitation Check Interval** | How often the server checks for expired invitations (minutes) | `15` |
| **Email Locale** | Language for invitation emails (`en` or `nl`) | `en` |

## How It Works

1. **Setup**: Add students and instructors via the admin panel. Organize students into groups. Define disciplines and assign them to groups.
2. **Create Timetable**: Define timeslots and assign groups with percentage allocations (e.g. Group A: 60%, Group B: 40%).
3. **Create Session**: Create a training session for a specific date; attach a timetable.
4. **Assign Instructors**: Select which instructors are available for that session. Each instructor creates one slot per timeslot.
5. **Generate Schedule**: Click "Generate Schedule" — the algorithm selects students based on priority, group quotas, preferred timeslots, buddy constraints, and more (see below).
6. **Send Invitations**: Click "Send Invitation Emails" to email students with personal RSVP links.
7. **Students Respond**: Students click their link to confirm or decline. The admin UI updates in real time via SSE.
8. **Auto-Replacement**: If a student declines or their invitation expires, the next eligible student is automatically invited and emailed.
9. **Complete Session**: After the session, click "Mark as Completed" to credit confirmed students. Mark no-shows as needed.

## Scheduling Algorithm

The schedule generation algorithm (`POST /sessions/:id/generate-schedule`) fills available slots with students using a multi-factor, multi-pass approach.

### Slot Calculation

Total slots = **number of active instructors** × **number of timeslots** in the attached timetable. Any slots occupied by manually-added invitations are subtracted from the available count.

### Eligibility Filters

A student is eligible for scheduling only if **all** of the following are true:

1. **Active**: the student is not deactivated
2. **Preferred days**: the session's day of week appears in the student's `preferred_days` list
3. **Not on cooldown**: the student has no active cooldown (`cooldown_until` is null or in the past)
4. **Not already invited**: the student has no active invitation (i.e. not scheduled, invited, or confirmed) for another session on the same date
5. **Group membership**: the student belongs to a group that is assigned to the session's timetable
6. **Discipline access**: the student's group has at least one active discipline linked via `discipline_groups`

Within each group, eligible students are sorted by **priority ascending** (lowest first), then alphabetically by last name and first name. Priority is stored **per group** (each student belongs to exactly one group), starts at 1, and is incremented each time a student is invited, ensuring that members who have been invited least often within their group are selected first. Priorities are normalized per group after each operation so the lowest active member of each group always has priority 1. Because priority values are only comparable within a group, the algorithm never compares priorities across groups.

### Group Allocation

Each timetable assigns groups with percentage allocations (e.g. Group A: 60%, Group B: 40%). The algorithm:

1. Computes the number of slots per group: `floor(available_slots × percentage / 100)`
2. Distributes any remainder slots round-robin across groups (in timetable-defined order)
3. Fills each group's quota from its eligible members, ordered by that group's priority

### Timeslot Assignment

When placing a student into a slot, the algorithm respects **preferred timeslots** — timeslot preferences stored per student per timetable. If a student has preferences set, only their preferred timeslots are considered. If no preferences are set, all timeslots are available.

Slots are assigned first-come, first-served across the timeslot × instructor grid.

### Buddy Group Scheduling

Students linked in a **buddy group** are scheduled together:

1. When a student is placed, the algorithm checks whether they have buddies in the same timetable group.
2. Buddies are placed immediately after, with a preference for **adjacent timeslots** (same timeslot, or ±1 slot from the original student's placement).
3. If an adjacent slot isn't available among the buddy's preferred timeslots, the algorithm falls back to any of their preferred timeslots.

### Overflow Pass

After each group's quota is filled, a second pass fills any remaining empty slots with eligible students from any timetable group. Because priorities are only comparable within a group, the pass repeatedly picks a group at **random, weighted by each group's timetable percentage**, then takes that group's highest-priority remaining candidate. This ensures no slots go to waste when some groups have fewer eligible students than their allocation, while keeping overflow selection proportional to each group's share.

### Auto-Replacement Algorithm

When a student declines or their invitation expires, the replacement algorithm (`findAndInviteReplacement`) finds a substitute:

1. **Same-group preference**: first tries to find a replacement from the same group as the original invitation, ordered by that group's priority
2. **Cross-group fallback**: if no same-group student is available, buckets eligible candidates by group and picks a group at **random, weighted by each group's timetable percentage**, then takes that group's highest-priority candidate
3. The replacement must pass the same eligibility filters (active, preferred days, no cooldown, not already invited on the same date, preferred timeslot match, discipline access)
4. The replacement inherits the exact timeslot and instructor slot of the declined/expired invitation
5. An invitation email is sent immediately and the expiry timer starts

### Priority Management

- Priority is stored per group; each time a student is invited (whether by schedule generation or as a replacement), their priority within their group is incremented by 1
- When schedule generation removes previous auto-generated invitations, the priority increment for those students is reversed
- After any priority change, priorities are normalized per group so the lowest active, non-cooldown member of each group has priority 1
- Administrators can manually adjust member priorities from the **Group detail page** (Members tab)

## Tech Stack

- **Backend**: Node.js, Express, TypeScript (executed via tsx), SQLite (better-sqlite3, WAL mode), Nodemailer
- **Frontend**: React, TypeScript, Vite, React Router
- **Database**: SQLite (file-based, no separate DB server needed)
- **Real-Time**: Server-Sent Events (SSE) for live admin updates
- **i18n**: English and Dutch (extensible)

## Docker

### Build

```bash
docker build -t session-scheduler .
```

### Run

```bash
docker run -p 3000:3000 \
  -v scheduler-data:/data \
  -e ADMIN_PASSWORD=changeme \
  session-scheduler
```

The app will be available at http://localhost:3000. In Docker, the frontend is built and served as static files from the backend — no separate frontend server is needed.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_PASSWORD` | Password for admin login | *(required)* |
| `PORT` | Server port | `3000` |
| `DB_PATH` | SQLite database file path | `/data/data.db` |
| `JWT_SECRET` | JWT signing key | Falls back to `ADMIN_PASSWORD` |
| `SMTP_HOST` | SMTP server for sending emails | — |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_SECURE` | Use TLS (true/false) | `false` |
| `SMTP_USER` | SMTP username | — |
| `SMTP_PASS` | SMTP password | — |
| `SMTP_FROM` | From address for emails | — |
| `FRONTEND_URL` | Base URL for links in emails | — |

### Data Persistence

The SQLite database is stored at `/data/data.db` inside the container. Mount a volume to persist data across container restarts:

```bash
# Named volume (recommended)
docker run -v scheduler-data:/data ...

# Bind mount to a host directory
docker run -v /path/on/host:/data ...
```
