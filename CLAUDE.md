# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Factory is a local AI coding automation platform. Users describe tasks in a web UI; the system spins up Claude Code CLI in an isolated git worktree, streams the output back to the browser in real time, commits any changed files, and opens a GitHub PR — all autonomously.

## Development commands

All commands run from `web/`:

```bash
# Start the Next.js UI (port 3001 per .env.local)
npm run dev

# Push Convex schema/function changes and watch for updates
npx convex dev

# Start the local job worker (polls Convex every 2s, spawns claude processes)
npm run worker

# Type-check
npx tsc --noEmit

# Lint
npm run lint
```

Three processes run in parallel during development: `npm run dev`, `npx convex dev`, and `npm run worker`.

## Architecture

### Data flow

```
Browser UI → Convex (cloud DB) ← worker/index.ts polls every 2s
                                    ↓
                              lib/queue.ts (startJob)
                                    ↓
                         git worktree created in <repo>/.worktrees/<jobId>/
                                    ↓
                         lib/claude-runner.ts spawns: claude --print --output-format stream-json
                                              --verbose --dangerously-skip-permissions [--resume SESSION_ID]
                                    ↓
                         stdout parsed → outputChunks written to Convex → UI reads live
                                    ↓
                         if files changed: git commit + push + GitHub PR
                         if no files: status = waiting_for_input (Claude asked a question)
```

### Key files

| File | Purpose |
|------|---------|
| `worker/index.ts` | Long-running process; polls `api.jobs.listByStatus` for queued/waiting jobs and calls `startJob()` |
| `lib/queue.ts` | Core job lifecycle: worktree creation, Claude session management, commit/PR on completion |
| `lib/claude-runner.ts` | Spawns `claude` CLI per turn; parses `stream-json` events; emits typed chunk prefixes |
| `lib/worktree.ts` | Git worktree CRUD: creates `job/<jobId>` branch at `<repo>/.worktrees/<jobId>/` |
| `convex/schema.ts` | DB schema — `projects`, `jobs`, `outputChunks`, `jobMessages`, `githubIssues`, `presence` |
| `convex/jobs.ts` | All Convex queries/mutations for job management |
| `app/page.tsx` | Single-page app shell: project switcher, tab router (Board/Agents/New Job), job detail panel |
| `components/JobDetail.tsx` | Right-panel: live terminal output + chat thread for `waiting_for_input` jobs |
| `components/AgentsGrid.tsx` | Mini-terminal cards showing live output per active agent |

### Job status lifecycle

```
pending → queued → running → completed
                           → failed
                           → waiting_for_input → running (when user replies)
                           → cancelled
```

`pending` = created but not queued. `queued` = worker will pick it up next tick. The worker also re-delivers user messages for `waiting_for_input` jobs when `lastUserMessageAt > completedAt`.

### Output chunk prefixes

`claude-runner.ts` tags each output chunk so the UI can colour-code it:

| Prefix | Colour | Meaning |
|--------|--------|---------|
| `\x00tool\x00` | cyan | File read/write/edit/glob/grep |
| `\x00bash\x00` | amber | Bash command |
| `\x00stderr\x00` | dim grey | Claude stderr |
| `[factory]` | indigo | Worker lifecycle messages |

Plain text is Claude's prose output (zinc-300).

### Convex

Always read `convex/_generated/ai/guidelines.md` before writing Convex queries or mutations — it overrides training-data assumptions about Convex APIs.

After changing `convex/schema.ts` or any file in `convex/`, run `npx convex dev` (or it will auto-push if already running).

`api.jobs.list` accepts an optional `projectId`. Pass `{}` to get all jobs across all projects.

### Project config (stored in Convex `projects` table)

- `localPath` — absolute path to the git repo on this machine (required for worktree creation)
- `githubToken` — personal access token for creating PRs (optional; skipped if absent)
- `agentRules` — prepended to every Claude prompt for this project; use it to point Claude at the project's own CLAUDE.md
- `defaultBranch` — base branch for worktrees (usually `main` or `master`)

### Next.js API routes

- `POST /api/execute` `{ jobId }` — start a single job immediately
- `DELETE /api/execute` `{ jobId }` — cancel a running job
- `POST /api/execute/batch` `{ projectId }` — queue all pending jobs for a project (worker picks them up)
- `POST /api/upload` — multipart image upload, returns base64 data URLs

### Next.js version note

This project uses Next.js 16 (App Router). Some APIs differ from training data — check `node_modules/next/dist/docs/` before writing route handlers or layout code.

## Environment variables

Set in `web/.env.local`:

```
NEXT_PUBLIC_CONVEX_URL=   # Convex deployment URL
CONVEX_DEPLOYMENT=        # dev:<name> — used by npx convex dev
GITHUB_ID=                # GitHub OAuth App client ID (for sign-in)
GITHUB_SECRET=            # GitHub OAuth App client secret
NEXTAUTH_SECRET=          # any random string
NEXTAUTH_URL=             # http://localhost:3001 in dev

# Email notifications (optional) — sent by the worker when a job completes/fails.
# The UI shows a desktop popup when a browser tab is open (tracked via the
# `presence` heartbeat); email is sent only when no browser is watching.
# Both RESEND_API_KEY and NOTIFY_EMAIL must be set or the email is skipped.
RESEND_API_KEY=           # Resend API key (https://resend.com)
NOTIFY_EMAIL=             # recipient address for job completion/failure emails
RESEND_FROM=              # optional "from" address; defaults to onboarding@resend.dev
```