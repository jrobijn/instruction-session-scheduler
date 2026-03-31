# Coaching Session Scheduler

A web application for scheduling coaching sessions at a sports club. Features an admin panel for managing students, instructors, and training evenings — with automated scheduling that prioritizes students with the fewest attended sessions.

## Features

- **Student Management**: Add, edit, activate/deactivate students
- **Instructor Management**: Add, edit, activate/deactivate instructors  
- **Training Evening Scheduling**: Create training evenings, assign instructors
- **Automatic Schedule Generation**: Allocates students with the lowest attended sessions first. Number of invitations = instructors × configurable sessions per instructor.
- **Email Invitations**: Sends invitation emails with personal links
- **Student RSVP**: Students can confirm or decline via a personal link
- **Auto-Replacement**: When a student declines, the next eligible student is automatically invited
- **Session Tracking**: Completing an evening increments attended sessions for confirmed students

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
- **Sessions per Instructor**: How many students each instructor coaches per evening
- **Invitation Email Subject**: Email subject line

## How It Works

1. **Setup**: Add students and instructors via the admin panel
2. **Create Evening**: Create a training evening for a specific date
3. **Assign Instructors**: Select which instructors are available that evening
4. **Generate Schedule**: Click "Generate Schedule" — the system selects students with the fewest attended sessions. The number of slots = instructors × sessions per instructor.
5. **Send Invitations**: Click "Send Invitation Emails" to email students with personal RSVP links
6. **Students Respond**: Students click their link to confirm or decline
7. **Auto-Replacement**: If a student declines, the next eligible student is automatically invited and emailed
8. **Complete Evening**: After the evening, click "Mark as Completed" to credit confirmed students

## Tech Stack

- **Backend**: Node.js, Express, SQLite (better-sqlite3), Nodemailer
- **Frontend**: React (Vite), React Router
- **Database**: SQLite (file-based, no separate DB server needed)
