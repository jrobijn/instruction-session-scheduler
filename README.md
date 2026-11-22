# Instruction Session Scheduler

A web application for scheduling instruction sessions at a sports club. Features an admin panel for managing students, instructors, groups, timetables, and training sessions — with an automated scheduling algorithm that takes into account whose turn it is, group allocation, preferred days and timeslots, buddy groups, cooldown periods, and discipline access.

## Features

- **Student Management**: Add, edit, activate/deactivate students; CSV import/export; preferred days and timeslot preferences; cooldown periods; membership IDs
- **Instructor Management**: Add, edit, activate/deactivate instructors; CSV import/export
- **Groups**: Organize students into groups with color coding. Each student belongs to one group. A default group can auto-assign new students.
- **Disciplines**: Define disciplines (e.g. swimming, tennis) with abbreviations. Control which groups have access to which disciplines.
- **Timetables**: Create reusable timetable templates with configurable timeslots and group percentage allocations (e.g. Group A: 60%, Group B: 40%). Mark a timetable as default for new sessions.
- **Buddy Groups**: Link 2+ students so they are always scheduled together at adjacent timeslots
- **Automatic Schedule Generation**: Turn-based algorithm that considers group allocation, preferred days/timeslots, buddy groups, cooldown periods, and discipline access (see [Scheduling Algorithm](#scheduling-algorithm) below)
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
go run .                 # Starts on http://localhost:3001 (needs Go 1.26+)
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev              # Starts on http://localhost:5173, proxies /api to the backend
```

### 3. Login

Open http://localhost:5173 and log in with the password set in `backend/.env` (default: `changeme`).

## Configuration

### Environment Variables

Edit `backend/.env` (see [backend/README.md](backend/README.md) for all variables):

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend port | `3001` |
| `FRONTEND_URL` | Frontend URL for email links | `http://localhost:5173` |
| `ADMIN_PASSWORD` | Password for admin login | *(required)* |
| `JWT_SECRET` | JWT signing key | Falls back to `ADMIN_PASSWORD` |
| `DB_PATH` | SQLite database file path | `./data.db` |
| `SMTP_HOST` | SMTP server for sending emails | — |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_SECURE` | Use TLS from the start (true) or STARTTLS (false) | `false` |
| `SMTP_USER` | SMTP username | — |
| `SMTP_PASS` | SMTP password | — |
| `SMTP_FROM` | From address for emails | `SMTP_USER` |

### In-App Settings

Configurable via the Settings page:

| Setting | Description | Default |
|---------|-------------|---------|
| **Club Name** | Shown in emails and the invitation page | `Sports Club` |
| **Club Days** | Which days of the week the club operates (pipe-delimited) | `0\|1\|2\|3\|4\|5\|6` |
| **Invitation Expiry Minutes** | How long invitations remain valid before auto-expiring; `0` = no time limit. An unanswered invitation always ends when its timeslot starts. | `120` |
| **Timezone** | The club's time zone, for timeslot start times and the day a cooldown ends | `Europe/Amsterdam` |
| **Email Locale** | Language for invitation emails (`en` or `nl`) | `en` |

## How It Works

1. **Setup**: Add students and instructors via the admin panel. Organize students into groups. Define disciplines and assign them to groups.
2. **Create Timetable**: Define timeslots and assign groups with percentage allocations (e.g. Group A: 60%, Group B: 40%).
3. **Create Session**: Create a training session for a specific date; attach a timetable.
4. **Assign Instructors**: Select which instructors are available for that session. Each instructor creates one slot per timeslot.
5. **Generate Schedule**: Click "Generate Schedule" — the algorithm selects students based on whose turn it is, group quotas, preferred timeslots, buddy constraints, and more (see below).
6. **Send Invitations**: Click "Send Invitation Emails" to email students with personal RSVP links.
7. **Students Respond**: Students click their link to confirm or decline. The admin UI updates in real time via SSE.
8. **Auto-Replacement**: If a student declines or their invitation expires, the next eligible student is automatically invited and emailed.
9. **Complete Session**: After the session, click "Mark as Completed" to credit confirmed students. Mark no-shows as needed.

## Scheduling Algorithm

The schedule generation algorithm (`POST /sessions/:id/generate-schedule`) fills available slots with students using a multi-factor, multi-pass approach.

### Slot Calculation

Total slots = **number of instructors assigned to the session** × **number of timeslots** in the attached timetable. Any slots occupied by manually-added invitations are subtracted from the available count.

### Eligibility Filters

A student is eligible for scheduling only if **all** of the following are true:

1. **Active**: the student is not deactivated
2. **Preferred days**: the session's day of week appears in the student's `preferred_days` list
3. **Not on cooldown**: the student has no cooldown, or it ends on or before the session date (in the club's timezone)
4. **Not already invited**: the student has no invitation to this session, in any status. A student who declined or let an invitation expire is therefore not invited again automatically (an admin still can). There is at most one session per date, so this also rules out being booked elsewhere that day.
5. **Group membership**: the student belongs to a group that is assigned to the session's timetable
6. **Discipline access**: the student's group has at least one active discipline linked via `discipline_groups`

Within each group, eligible students are ordered by their **invite queue** (see [Invite Queue](#invite-queue)): whoever has waited longest since their last counted invitation goes first; ties are broken randomly. Queues are per group, so the algorithm never compares queue positions across groups.

### Group Allocation

Each timetable assigns groups with percentage allocations (e.g. Group A: 60%, Group B: 40%). The algorithm:

1. Computes the number of slots per group: `floor(available_slots × percentage / 100)`
2. Distributes any remainder slots round-robin across groups (in timetable-defined order)
3. Selects each group's quota from its eligible members, in that group's queue order (pulling up buddies, see below)

### Timeslot Assignment

The algorithm respects **preferred timeslots** — timeslot preferences stored per student per timetable. If a student has preferences set, only their preferred timeslots are considered. If no preferences are set, all timeslots are available.

Selected students are then placed in timeslots, in queue order:

1. Students with timeslot preferences go first, since they have the fewest options. A student who can't be placed is replaced by the next student in their group's queue.
2. Students without preferences fill the remaining spots.

A student takes the earliest allowed timeslot with room. If all of them are full, students placed earlier may be moved to another timeslot they allow to make room; nobody who was placed is ever dropped. Each placed student then gets the first free instructor in their timeslot.

### Buddy Group Scheduling

Students linked in a **buddy group** are scheduled together:

1. **Selection**: when a student is selected within their group's quota, their buddies in the same group are selected right after them, ahead of their turn, while the quota lasts. Buddies selected this way don't pull up buddies of their own.
2. **Placement**: a student whose buddy is already placed goes in the allowed timeslot closest to that buddy's (the same timeslot if possible, the earlier one on ties).
3. When students have to be moved to make room, others are moved before buddies, so buddies aren't split up when that can be avoided.

### Overflow Pass

After the group quotas are placed, a final pass fills any remaining empty slots with eligible students from any timetable group who haven't been tried yet. Because queues are per group, the pass repeatedly picks a group at **random, weighted by each group's timetable percentage**, then tries the first remaining candidate in that group's queue. This ensures no slots go to waste when some groups have fewer eligible students than their allocation, while keeping overflow selection proportional to each group's share. Buddies play no part in this pass.

### Auto-Replacement Algorithm

When a student declines, cancels after confirming, or lets their invitation expire, the replacement algorithm (`findAndInviteReplacement`) finds a substitute. An admin can also fill an open spot this way with "auto-schedule slot"; cancelling an invitation as admin does not trigger a replacement by itself.

1. **Eligibility**: candidates must pass the same eligibility filters as for generating a schedule, and allow the spot's timeslot
2. **Same-group preference**: first tries the same group as the original invitation, in that group's queue order. A candidate whose buddy is already invited to the session goes first. For a spot that held a manually-added invitation (no group), this step uses the whole queue.
3. **Cross-group fallback**: if no same-group student is available, buckets eligible candidates by group and picks a group at **random, weighted by each group's timetable percentage**, then takes the first candidate in that group's queue
4. The replacement inherits the exact timeslot and instructor slot of the vacated invitation
5. An invitation email is sent immediately and the expiry timer starts

### Invite Queue

There is no stored priority number; the queue is derived from invitation history, so it needs no manual upkeep.

- A student's **last turn** is the date of the latest session they have a `scheduled`, `invited` or `confirmed` invitation for. Declined, expired and (admin-)cancelled invitations do not count, and regenerating a schedule simply deletes the old invitations — so no reversal bookkeeping is needed.
- Students who waited longest go first; never-invited students go to the front.
- **New members / reactivated members / after a cooldown** (per-group settings): the moments a student joined a group (`joined_at`), was reactivated (`reactivated_at`) and ended a cooldown (`cooldown_until`) are always stored. For each setting set to *Back of the queue*, that moment counts like a last turn (the student is ordered by the latest of them); with *By invitation history* it is ignored. Settings are applied at query time, so changing one immediately re-orders affected members — existing invitations are never changed. Removing a cooldown early ends it now instead of erasing it, so it still counts.
- **Invite next** (Group detail page → member actions): moves a member to the front until they receive a counted invitation. If that invitation is declined or cancelled, the override stays active.

## Tech Stack

- **Backend**: Go (standard library HTTP server and SMTP client), SQLite via the pure-Go `modernc.org/sqlite` driver (WAL mode)
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

The app will be available at http://localhost:3000. In Docker, the frontend is built and served as static files from the backend — no separate frontend server is needed. The image is a single static Go binary on Alpine (about 35 MB).

To check the mail server's TLS settings without sending email, see [backend/README.md](backend/README.md#email).

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
| `SMTP_FROM` | From address for emails | `SMTP_USER` |
| `FRONTEND_URL` | Base URL for links in emails; set it to the app's public URL, or invitation links point to localhost | `http://localhost:5173` |

### Data Persistence

The SQLite database is stored at `/data/data.db` inside the container. Mount a volume to persist data across container restarts:

```bash
# Named volume (recommended)
docker run -v scheduler-data:/data ...

# Bind mount to a host directory
docker run -v /path/on/host:/data ...
```
