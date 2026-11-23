# Agent instructions

## Project facts

- `frontend/` and `backend/` ship together in one Docker image (the backend serves the built frontend). When an API changes, update the frontend in the same change and don't keep code paths for responses only an older backend sends.
- No reverse proxy sits in front of the backend servers: they face clients directly, so they must enforce body limits, timeouts and similar safeguards themselves.

## Skills

Project skills live in `.agents/skills/` (`.claude/skills` is a symlink to it).

- Before any UI work in a frontend (React pages, components, CSS), load the `frontend-design` skill.
- Before writing, refactoring or reviewing Go code in a backend, load the `go-backend` skill.
