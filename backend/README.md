# Backend

The Go HTTP server for the scheduler: the JSON API under `/api`, Server-Sent Events for live admin updates, invitation emails, expiry timers, and, in production, the built frontend.

The only third-party dependency is the pure-Go SQLite driver [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite), so the server builds without a C toolchain. Routing, JWT, SMTP, SSE, CSV and `.env` handling all use the standard library.

## Running

```bash
cd backend
cp .env.example .env     # then edit
go run .                 # http://localhost:3001
go test ./...
```

The frontend dev server (`cd frontend && npm run dev`) talks to it on port 3001.

Environment variables (read from `.env` if present; real environment variables win):

| Variable | Notes | Default |
|---|---|---|
| `PORT` | HTTP port | `3001` |
| `FRONTEND_URL` | Allowed CORS origin and base URL for links in emails | `http://localhost:5173` |
| `ADMIN_PASSWORD` | Admin login password | *(required)* |
| `JWT_SECRET` | Signing key for the login cookie | `ADMIN_PASSWORD` |
| `DB_PATH` | SQLite database file, relative to the working directory | `data.db` |
| `PUBLIC_DIR` | Built frontend to serve | `public` |
| `APP_ENV=production` | Marks the login cookie `Secure` (`NODE_ENV=production` also works) | — |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Mail server; without `SMTP_HOST`/`SMTP_USER`, emails are only logged | port `587` |
| `EMAIL_PREVIEW_DIR` | Without SMTP: also save each email's HTML here | — |

## Email

- **TLS:** Go's default settings (TLS 1.2 or newer). With `SMTP_SECURE=true` the connection uses TLS from the start, otherwise STARTTLS.
- **Login:** AUTH PLAIN, and only over TLS.
- **Sending:** in the background, one email at a time over its own connection, so a batch of invitations never opens parallel connections to the club's mail server. Failures are only logged; the request that triggered the email still succeeds.

`go run . -smtp-check` (or `./server -smtp-check` in the container) connects with the configured settings. It reports the negotiated TLS version and cipher, the certificate chain and the offered AUTH methods, then tests the login, without sending any email.

## Database

The server creates the schema on an empty database. Databases from before the switch to Go must have been migrated by the last TypeScript release (git commit `75f9869`). The server refuses to start on an older one and says which column is missing; run that release on it once to migrate it.

## Layout

| Path | Contents |
|---|---|
| `main.go` | Startup and shutdown |
| `internal/server/` | Routes, one file per resource; `schedule.go` is schedule generation; `timing.go` and `timers.go` handle invitation expiry |
| `internal/queue/` | Invite queue SQL, seeded PRNG, tie-breaking |
| `internal/email/` | Email templates (en/nl) and SMTP |
| `internal/sse/` | Server-Sent Events hub |
| `internal/db/` | Database schema and query helpers |
| `internal/auth/` | HS256 JWT |
| `internal/config/` | Environment and `.env` |

All handlers and expiry timers share one mutex, and the database uses a single connection: a handler's statements never interleave with another's.

## Changes from the former TypeScript backend

The Go server replaced the Express backend after commit `75f9869`. Its API is the same: same JSON bodies, cookies, SSE events, email HTML and scheduling decisions. Where they differ:

- **Removed variable:** `SMTP_TLS_CIPHERS` is gone, along with OpenSSL cipher strings. The club's mail server works with Go's default TLS.
- **Email:** credentials are never sent over an unencrypted connection, and AUTH LOGIN is no longer used.
- **Login:** a login without a password is rejected even when `ADMIN_PASSWORD` is unset.
- **Request bodies:** booleans in request bodies are stored as `1`/`0`, and numbers sent for text fields are stored as e.g. `"5"`.
- **Error responses:** malformed JSON and unexpected errors return a JSON error instead of an HTML page.
- **Transactions:** buddy-group creation, student deletion and the set-default endpoints run in a transaction.
