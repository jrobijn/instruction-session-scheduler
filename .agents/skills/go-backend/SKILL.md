---
name: go-backend
description: Coding conventions for the Go backends. Use when writing, refactoring or reviewing Go code or tests in a backend, especially HTTP handlers and SQL queries.
---

# Go backend conventions

Backends are Go with few dependencies. Prefer the standard library and plain Go idioms.

Paths below (`internal/server`, `main.go`, …) are relative to the root of the backend you are working in, e.g. `backend/` (see [backend/README.md](../../../backend/README.md)). Examples name functions in `backend/`; follow the same pattern elsewhere.

## Go idioms over Express parity

The backend was ported from Express/TypeScript. Parity was a migration aid, not a requirement: the frontend and the stored data are the real contract. Before keeping a TS-era quirk (`value || null` → null, body-parser behaviour, Intl edge cases), check whether the frontend or stored data actually depends on it. If not, use the Go-native behaviour and update tests that only pinned TS parity.

## Helpers

- Don't add helpers that wrap one or two stdlib calls. Inline them so details such as an ignored error stay visible at the call site: `if n, _ := res.RowsAffected(); n == 0 {`, `s.mu.Lock()` / `defer s.mu.Unlock()`.
- A helper is justified when it:
  - holds real logic (`decode`, `isUniqueErr` in `internal/server/helpers.go`);
  - fixes a project-wide convention that would otherwise be repeated at every call site (`pathID`: base-10 int64 path ids);
  - enforces a safeguard (`decode`'s 1 MiB `http.MaxBytesReader`).
- Encapsulation is not an argument for a helper inside one package: unexported fields are already visible to the whole package.

## Handlers

1. Each handler parses `{id}` itself with `pathID` and writes every HTTP response itself. No `loadX(r)` / `requireX(r)` helpers that read the request.
2. Handlers load the full entity. Each resource whose full row is selected by id has one `getX(q, id) (X, bool, error)` with the canonical column list, even if it has a single caller, placed directly under the entity's struct. A shared full-list query is `getXs(q)`, placed right after `getX`. Reference: `getSession` in `internal/server/sessions.go`.
3. "Does the parent exist" checks stay inline: `db.One[int](q, "SELECT 1 FROM … WHERE id = ?", id)`. No exists helper.
4. A single write to the row itself needs no pre-check: detect not-found via `RowsAffected` or `RETURNING`.
5. Add other shared query functions or SELECT constants only when several callers must agree on rows, order or columns.

## Write ordering and errors

- Put every read that can fail before the first write. A 500 after a committed write misleads the user (e.g. it skips the confirmation email and shows an error for an action that succeeded).
- After the main write has committed, failures in side effects (broadcasts, notifications, "session full" checks) are logged with `log.Printf` and the handler carries on, like `broadcastSessionCounts`.

## SQL

- Never pass a WHERE clause or other SQL fragment as a function parameter.
- For a shared row shape, use a SELECT constant plus one small function per filter that appends a fixed WHERE: `selectInvitationDetails` + `invitationByID` / `invitationByToken` in `internal/server/invitations.go`.

## Server safeguards

No reverse proxy sits in front of the backend servers. Each must enforce body limits, timeouts (`ReadHeaderTimeout` in `main.go`) and similar protections itself. Keep them, and flag missing ones.

## Blank-line spacing

Separate distinct concerns with blank lines so it is clear where one check ends and the next begins.

- Blank line after each finished check block before the next concern: decode error vs field validation, one path param vs another, existence lookup, status checks.
- A call stays attached to its `if err != nil` and to direct follow-ups on its results (`if !found`, `if n, _ := res.RowsAffected()`, `isUniqueErr(err, …)` then `if err != nil`).
- Blank line after the closing `}` of an if/for/switch/func/type block, and before the final `httpx.OK…; return nil` when it follows a block.
- `defer x.Close()` stays glued to the open and its err check; blank line after the defer.
- Composite-literal closers (`})` of `httpx.OK(w, T{…})`, `params := T{…}`) are plain statements: no forced blank line.
- A block that computes a value stays glued to the `if`/`switch` that checks it (a loop building `out`, then `if len(out) …`).
- Blank line before a comment that introduces a new step. No blank lines at the start or end of a block.
- Tests: a run of assertions on one result is one paragraph. Blank lines go between action-and-assertion groups, and between checks of separate scenarios (different inputs to the same function).
