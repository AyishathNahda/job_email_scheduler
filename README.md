# ReachInbox — Cold Email Job Scheduler

A production-grade, distributed cold-email scheduling and execution engine built to send emails at the right time, at the right rate, **strictly exactly once** — even across worker crashes and process restarts.

Built on **MySQL 8** (the durable state ledger) and **Redis 7 + BullMQ** (the high-precision delayed timer queue).

---

## Key Architectural Principles

1. **No Polling / No Cron Loops**:
   Email jobs are scheduled as BullMQ delayed jobs scored by their calculated due timestamp (`sendAt`) in Redis. The BullMQ delayed set acts as the schedule data structure itself, waking up workers precisely when jobs mature without any database polling.
2. **Four-Gate Worker Pipeline**:
   Every worker execution passes through 4 defensive gates:
   - **Gate 1 (Load & Verify)**: Checks job existence and idempotency preconditions (`status === SCHEDULED`).
   - **Gate 2 (Atomic Rate Limit Check)**: Executes an atomic Redis Lua script enforcing per-sender hourly quotas and minimum inter-send delays. If rate limited, defers the job with exponential jitter without claiming the DB lock.
   - **Gate 3 (Atomic Claim / Compare-And-Swap)**: Transitions status from `SCHEDULED` to `PROCESSING` via atomic SQL CAS (`updateMany` with `status: SCHEDULED`). If another worker claimed the job, count is 0 and the duplicate stands down immediately.
   - **Gate 4 (SMTP Send & Finalize)**: Dispatches via SMTP (e.g. Ethereal / custom SMTP). On success marks `SENT`. On transient failure increments attempt count and reschedules with exponential backoff.
3. **Atomic Multi-Constraint Rate Limiter**:
   Uses a single Redis Lua script to atomically check and commit both:
   - Hourly rolling/bucket quota per sender account.
   - Minimum delay between consecutive emails per sender account.
4. **Crash-Resilient Reconciler**:
   Runs at worker boot to recover stranded states:
   - Re-enqueues any `SCHEDULED` jobs in MySQL that are missing from Redis BullMQ.
   - Marks abandoned `PROCESSING` jobs older than the stale threshold as `FAILED` for auditability and cleanup.
5. **Fair Multi-Sender Scheduling Planner**:
   A purely functional scheduler (`planner.ts`) that round-robins recipients across all available sender accounts, computing exact timestamps according to hourly throughput limits and inter-email delay constraints.

---

## Tech Stack

- **Backend**: Node.js, Express, TypeScript, Prisma ORM, MySQL 8, Redis 7, BullMQ, Pino logger, Nodemailer.
- **Frontend**: Next.js 15 (App Router), React, TypeScript, Vanilla CSS design system.
- **Testing**: Vitest, Supertest, Concurrency & Rate Limiting integration suites.

---

## Quick Start

### 1. Prerequisites
- Node.js >= 20.6.0
- pnpm >= 10.0.0
- Docker & Docker Compose

### 2. Start Infrastructure
```bash
docker compose up -d          # Starts MySQL 8 (port 3306) and Redis 7 with AOF (port 6379)
```

### 3. Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Set `ENCRYPTION_KEY`, `JWT_SECRET`, and optional Google OAuth keys in `.env`.

### 4. Database Setup & Seed
```bash
pnpm install
pnpm db:migrate               # Applies Prisma migrations
pnpm seed:senders             # Provisions 3 Ethereal test SMTP sender accounts
```

### 5. Run Application
```bash
pnpm dev                      # Starts API (port 3000), Worker, and Frontend (port 3001)
```

---

## Project Structure

```
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma           # MySQL schema (Users, Senders, Campaigns, EmailJobs)
│   │   └── migrations/             # Versioned SQL migrations
│   ├── src/
│   │   ├── http/                   # Express routes & middlewares
│   │   │   ├── routes/             # auth, senders, campaigns (including /jobs)
│   │   │   └── middlewares/        # JWT auth, error handlers
│   │   ├── lib/                    # Pure utilities: planner, crypto, logger, config
│   │   ├── queue/                  # BullMQ queue, worker, 4-gate processor, reconciler, Lua rate limiter
│   │   ├── scripts/                # seedSenders.ts, loadTest.ts
│   │   ├── services/               # campaignService, senderService, authService
│   │   ├── server.ts               # HTTP Server entrypoint
│   │   └── worker.ts               # BullMQ Worker entrypoint
│   └── vitest.config.ts
├── frontend/
│   ├── app/                        # Next.js App Router (Dashboard, Campaign creation, Auth)
│   └── components/                 # UI components and job status monitors
├── docker-compose.yml              # MySQL + Redis with persistent volumes
└── package.json                    # Workspace orchestration
```

---

## Testing & Verification

### Unit & Integration Tests
Run the comprehensive test suite across the workspace:
```bash
pnpm test
```
Covering:
- **CAS Concurrency**: 10 parallel worker invocations on a single job ensuring strictly 1 delivery.
- **Hourly Quota Rollover**: Validates bucket reset across hour boundaries.
- **Reconciler Recovery**: Validates stale lock recovery and missing job re-enqueuing.
- **HTTP Endpoints**: Full API integration testing.

### Load Test
Simulate and verify the distribution of 1,000 email jobs across 3 senders:
```bash
pnpm loadtest
```
Validates:
- Correct round-robin distribution (~333 jobs/sender).
- Strictly monotonic timestamp sequencing.
- Adherence to hourly limits and minimum delay intervals.

---

## API Reference

### Authentication
- `POST /api/auth/register` — Register with email/password.
- `POST /api/auth/login` — Login and receive JWT HTTP-only cookie.
- `POST /api/auth/logout` — Clear session cookie.
- `GET /api/auth/me` — Retrieve current authenticated user.

### Sender Management
- `GET /api/senders` — List sender accounts for user.
- `POST /api/senders` — Add new SMTP sender account (credentials encrypted at rest).

### Campaigns & Scheduling
- `POST /api/campaigns` — Create and schedule a cold-email campaign.
- `GET /api/campaigns` — List all campaigns with real-time aggregated metrics.
- `GET /api/campaigns/:id` — Get single campaign details and breakdown.
- `GET /api/campaigns/jobs` — Retrieve full job ledger with filter support (`campaignId`, `status`, pagination).
