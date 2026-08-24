# ReachInbox — Email Job Scheduler

A production-grade service that schedules cold-email campaigns and sends them at
the right time, at the right rate, **exactly once** — even across process
restarts. Scheduling is BullMQ delayed jobs (no cron, no polling loop); MySQL is
the ledger and Redis is the timer.

> **Status:** built in phases. This README is expanded fully in Phase 8. See the
> git history for the phase-by-phase story.

## Quick start

```bash
docker compose up -d          # MySQL 8 + Redis 7 (AOF on)
cp .env.example .env          # then fill JWT_SECRET / ENCRYPTION_KEY / GOOGLE_CLIENT_ID
pnpm install
pnpm db:migrate               # apply Prisma migrations (Phase 1+)
pnpm seed:senders             # provision 3 Ethereal SMTP senders (Phase 2+)
pnpm dev                      # api + worker + frontend
```

`ENCRYPTION_KEY` must be 32 bytes as 64 hex chars:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Layout

- `backend/` — Express API (`server.ts`) + BullMQ worker (`worker.ts`), two
  separate processes sharing library code.
- `frontend/` — Next.js dashboard.
- `docker-compose.yml` — MySQL + Redis with named volumes (data survives restart).

## Why no cron

Scheduling is a Redis sorted set scored by due-timestamp, managed by BullMQ. A
worker holds a timer to the next-due job and promotes jobs as they mature —
**the schedule is the data structure**, so there is nothing to poll. See the
Architecture section (Phase 8) for details.
