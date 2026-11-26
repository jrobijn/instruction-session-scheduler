# Backend

The Go HTTP server for the scheduler: the JSON API under `/api`, Server-Sent Events for live admin updates, invitation emails, expiry timers, and, in production, the built frontend.

Direct dependencies are kept small: the pure-Go SQLite driver [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) (so the server builds without a C toolchain), [`sqlx`](https://pkg.go.dev/github.com/jmoiron/sqlx) for query helpers, [`goose`](https://pkg.go.dev/github.com/pressly/goose/v3) for migrations, and [`google/uuid`](https://pkg.go.dev/github.com/google/uuid). Routing, JWT, SMTP, SSE and `.env` handling all use the standard library.

## Running

```bash
cd backend
cp .env.example .env     # then edit
go run .                 # http://localhost:3001
go test ./...
```

The frontend dev server (`cd frontend && npm run dev`) proxies `/api` to it on port 3001, so the
browser sees a single origin in development just as in production.

Environment variables (read from `.env` if present; real environment variables win):

| Variable | Notes | Default |
|---|---|---|
| `PORT` | HTTP port | `3001` |
| `FRONTEND_URL` | Base URL for links in emails | `http://localhost:5173` |
| `ADMIN_PASSWORD` | Admin login password; the server refuses to start without it | *(required)* |
| `JWT_SECRET` | Signing key for the login cookie | `ADMIN_PASSWORD` |
| `DB_PATH` | SQLite database file, relative to the working directory | `data.db` |
| `PUBLIC_DIR` | Built frontend to serve | `public` |
| `APP_ENV=production` | Marks the login cookie `Secure` | — |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Mail server; without `SMTP_HOST`/`SMTP_USER`, emails are only logged | port `587` |
| `EMAIL_PREVIEW_DIR` | Without SMTP: also save each email's HTML here | — |

## Email

- **TLS:** Go's default settings (TLS 1.2 or newer). With `SMTP_SECURE=true` the connection uses TLS from the start, otherwise STARTTLS.
- **Login:** AUTH PLAIN, and only over TLS.
- **Sending:** in the background, one email at a time over its own connection, so a batch of invitations never opens parallel connections to the club's mail server. Failures are only logged; the request that triggered the email still succeeds.

To see what the mail server negotiates without sending email, use `openssl` with your `SMTP_HOST` and `SMTP_PORT`:

```bash
openssl s_client -connect <SMTP_HOST>:<SMTP_PORT> -starttls smtp -brief   # STARTTLS
openssl s_client -connect <SMTP_HOST>:<SMTP_PORT> -brief                  # SMTP_SECURE=true
```

It prints the TLS version, cipher and certificate. Type `EHLO test` to see the offered AUTH methods, then `QUIT`. To test the login, send yourself an invitation.

## Database

The schema is managed with [goose](https://github.com/pressly/goose) migrations in `internal/db/migrations/`, embedded in the binary. The server applies pending migrations on startup and records them in the `goose_db_version` table. `go run . -migrate` (or `./server -migrate` in the container) applies them and exits, without starting the server.

Before applying migrations to a database that has data, the server writes a backup next to it as `<db>.bak-v<version>` (with a `-YYYYMMDD-HHMMSS` suffix if that file already exists). It refuses to start on a database that a newer build has migrated.

To change the schema, add a new file `NNNNN_description.sql` with the next number, starting with `-- +goose Up`. Never edit a migration that has been released, because databases that already ran it won't run it again. To rebuild a table (needed to change a constraint or column type), turn foreign keys off with `PRAGMA foreign_keys` first. That pragma is ignored inside a transaction, so such a migration needs `-- +goose NO TRANSACTION`.

The server refuses to start on a database that has tables but no `goose_db_version` history.

## Layout

| Path | Contents |
|---|---|
| `main.go` | Startup and shutdown |
| `internal/server/` | Routes, one file per resource; `schedule.go` and `replacement.go` load data for and apply the decisions of `internal/scheduling`; `timing.go` and `timers.go` handle invitation expiry |
| `internal/scheduling/` | Who is invited to a session and in which timeslot: slot allocation, weighted group picks, buddy selection, timeslot matching, replacement picks (no I/O) |
| `internal/queue/` | Invite queue: loading members with their standing (`queue.sql`) and tie-breaking |
| `internal/email/` | Email templates (en/nl) and SMTP |
| `internal/sse/` | Server-Sent Events hub |
| `internal/db/` | Opening SQLite, goose migrations, query helpers |
| `internal/httpx/` | Shared JSON response and error helpers |
| `internal/auth/` | HS256 JWT |
| `internal/config/` | Environment and `.env` |

All request handlers except SSE streams, and the expiry timers, share one mutex, and the database uses a single connection: a handler's statements never interleave with another's.