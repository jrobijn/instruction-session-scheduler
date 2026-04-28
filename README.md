# Coaching Session Scheduler

A web application for scheduling coaching sessions at a sports club. Features an admin panel for managing students, instructors, and training sessions — with automated scheduling that prioritizes students with the fewest attended sessions.

## Features

- **Student Management**: Add, edit, activate/deactivate students
- **Instructor Management**: Add, edit, activate/deactivate instructors  
- **Training Session Scheduling**: Create training sessions, assign instructors
- **Automatic Schedule Generation**: Allocates students with the lowest attended sessions first. Number of invitations = instructors × configurable sessions per instructor.
- **Email Invitations**: Sends invitation emails with personal links
- **Student RSVP**: Students can confirm or decline via a personal link
- **Auto-Replacement**: When a student declines, the next eligible student is automatically invited
- **Session Tracking**: Completing a session increments attended sessions for confirmed students

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

Edit `backend/.env`:

| Variable | Description |
|----------|-------------|
| `PORT` | Backend port (default: 3001) |
| `FRONTEND_URL` | Frontend URL for CORS and email links |
| `ADMIN_PASSWORD` | Password for admin login |
| `SMTP_HOST` | SMTP server for sending emails |
| `SMTP_PORT` | SMTP port (default: 587) |
| `SMTP_SECURE` | Use TLS (true/false) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `SMTP_FROM` | From address for emails |

In-app settings (via Settings page):
- **Club Name**: Shown in emails and invitation page
- **Sessions per Instructor**: How many students each instructor coaches per session
- **Invitation Email Subject**: Email subject line

## How It Works

1. **Setup**: Add students and instructors via the admin panel
2. **Create Session**: Create a training session for a specific date
3. **Assign Instructors**: Select which instructors are available for that session
4. **Generate Schedule**: Click "Generate Schedule" — the system selects students with the fewest attended sessions. The number of slots = instructors × sessions per instructor.
5. **Send Invitations**: Click "Send Invitation Emails" to email students with personal RSVP links
6. **Students Respond**: Students click their link to confirm or decline
7. **Auto-Replacement**: If a student declines, the next eligible student is automatically invited and emailed
8. **Complete Session**: After the session, click "Mark as Completed" to credit confirmed students

## Tech Stack

- **Backend**: Node.js, Express, SQLite (better-sqlite3), Nodemailer
- **Frontend**: React (Vite), React Router
- **Database**: SQLite (file-based, no separate DB server needed)

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

The app will be available at http://localhost:3000.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_PASSWORD` | Password for admin login | *(required)* |
| `PORT` | Server port | `3000` |
| `DB_PATH` | SQLite database file path | `/data/data.db` |
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
