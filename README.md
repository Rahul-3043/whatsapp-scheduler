# WhatsApp Message Scheduler

Schedule a WhatsApp message now; a background worker sends it at the exact
scheduled time in **Asia/Kolkata**, and webhooks keep delivery and read status
up to date.

Built with Next.js 16 (App Router), TypeScript, Tailwind v4, PostgreSQL 16,
Prisma, BullMQ + Redis, and Meta's official WhatsApp Cloud API.

---

## How it works

```
  Browser
     │  POST /api/messages  (date + time in IST)
     ▼
  Next.js route handler
     │  1. validate + convert IST → UTC
     │  2. INSERT row (PENDING)
     │  3. add delayed BullMQ job  ──────────────►  Redis (persistent)
     │  4. UPDATE row (QUEUED)
     ▼
  ──────────  browser can close here  ──────────

  Worker (separate process, always running)
     │  at the scheduled instant, BullMQ hands it the job
     │  1. atomic claim: QUEUED → SENDING  (duplicate-send guard)
     │  2. POST to Meta Cloud API
     │  3. store wamid, mark SENT
     ▼
  Meta
     │  webhook: delivered / read / failed
     ▼
  POST /api/webhooks/whatsapp
     │  verify HMAC → dedupe → move status forward
     ▼
  PostgreSQL  ──►  GET /api/messages/:id
```

### Why a separate worker

The scheduler cannot live in the web process: Next.js route handlers are
request-scoped, and a `setTimeout` dies with the dev server. BullMQ keeps
delayed jobs in Redis, and a standalone process consumes them — so closing the
browser, restarting Next.js, or restarting the worker all leave scheduled
messages intact.

### How duplicates are prevented

Three independent layers:

1. **Deterministic job id** — `msg:<messageId>`. Enqueuing the same message
   twice updates the existing job instead of adding a second one.
2. **Atomic claim** — `UPDATE ... WHERE status IN ('PENDING','QUEUED')`. Only
   the caller that actually flips the row proceeds to send.
3. **Stale recovery** — a row stuck in `SENDING` for over 10 minutes (worker
   crashed mid-send) can be re-claimed; fresh ones cannot.

---

## Quick start

```bash
# 1. Database role (one time)
sudo -u postgres psql \
  -c "CREATE ROLE whatsapp WITH LOGIN PASSWORD 'YourStrongPassword123';" \
  -c "CREATE DATABASE whatsapp_scheduler OWNER whatsapp;"

# 2. Redis
docker compose up -d

# 3. Configure
cp .env.example .env      # fill in DATABASE_URL and WhatsApp credentials

# 4. Install + migrate
npm install
npx prisma migrate dev --name init

# 5. Run — two terminals
npm run dev               # terminal 1: web app on :3000
npm run worker            # terminal 2: background sender
```

Then open <http://localhost:3000>.

Full instructions: **[docs/SETUP.md](docs/SETUP.md)**
WhatsApp credentials and webhook setup: **[docs/WHATSAPP.md](docs/WHATSAPP.md)**

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/messages` | Create a scheduled message |
| `GET` | `/api/messages` | List messages (`?status=`, `?limit=`) |
| `GET` | `/api/messages/:id` | Status, receipts and full event history |
| `POST` | `/api/messages/:id/cancel` | Cancel a `PENDING`/`QUEUED` message |
| `GET`/`POST` | `/api/webhooks/whatsapp` | Meta verification + status events |
| `GET` | `/api/health` | Postgres / Redis / credentials check |

Create a message:

```bash
curl -X POST localhost:3000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "recipientName": "Rahul Sharma",
    "phoneNumber": "+919876543210",
    "messageContent": "Reminder: your appointment is tomorrow at 10:30 AM.",
    "scheduledDate": "2026-11-05",
    "scheduledTime": "09:30"
  }'
```

```json
{
  "message": {
    "id": "cm3x...",
    "status": "QUEUED",
    "scheduledAt": "2026-11-05T04:00:00.000Z",
    "scheduledAtLabel": "Thu, 05 Nov 2026 at 09:30 AM",
    "timezone": "Asia/Kolkata"
  }
}
```

---

## Project layout

```
app/
  page.tsx                              single-page form
  api/messages/route.ts                 create + list
  api/messages/[id]/route.ts            status + event history
  api/messages/[id]/cancel/route.ts     cancel
  api/webhooks/whatsapp/route.ts        Meta verification + status webhooks
  api/health/route.ts                   connectivity check
components/schedule-form.tsx            the form
lib/
  env.ts            validated, server-only configuration
  time.ts           IST ⇄ UTC conversion (Luxon)
  validation.ts     Zod schemas + input sanitisers
  queue.ts          BullMQ queue, deterministic job ids
  prisma.ts         Prisma singleton
  logger.ts         structured (pino) logging, secrets redacted
  messages/service.ts   atomic claim + send + failure handling
  whatsapp/client.ts    Cloud API client, typed errors, retries
  whatsapp/status.ts    idempotent, monotonic status transitions
  whatsapp/webhook-verify.ts   HMAC-SHA256 signature check
worker/index.ts                         the background sender
scripts/reconcile.ts                    lost-job / crash recovery
prisma/schema.prisma                    data model
```

---

## Scheduled tasks

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run worker` | Background worker (watch mode) |
| `npm run reconcile` | Recover lost jobs; safe to run anytime |
| `npm run db:migrate` | Create + apply a migration |
| `npm run db:studio` | Browse data |
| `npm run typecheck` | `tsc --noEmit` |

---

## Design decisions

**Times are stored as UTC.** The DB holds exact instants; IST is applied only
when reading form input and rendering. This keeps delays, comparisons, and
queue arithmetic correct regardless of server timezone.

**The webhook verifies HMAC over the raw body.** Re-serialising parsed JSON
changes the bytes and breaks the signature, so the route reads `request.text()`
first. Unsigned payloads are rejected — otherwise anyone could forge read
receipts.

**Statuses only move forward.** `SENT → DELIVERED → READ`, with timestamps
written once. Late or duplicate webhooks cannot downgrade a row.

**`SENT` is not `DELIVERED`.** An API 200 means Meta accepted the message. Only
a webhook proves the recipient's device received it, and read receipts are
optional on WhatsApp — the API reports "unknown" rather than guessing.

**Failures are classified.** 4xx errors (bad token, unapproved template,
unknown recipient) fail immediately; 429/5xx and network errors retry with
exponential backoff (1 min → 5 min → 15 min).

---

## Before deploying

- Set `WHATSAPP_APP_SECRET` — webhook signature checking is mandatory.
- Run the worker as a supervised service (systemd, Docker, ECS task) with
  restart-on-failure.
- Schedule `npm run reconcile` on a timer.
- Use a permanent System User token, not the 24-hour test token.
- Move secrets to a secret manager rather than `.env`.
- Put the app behind HTTPS; Meta will not call an `http://` webhook.
- Consider Postgres advisory locks or a higher worker `concurrency` as load
  grows; the atomic claim already makes horizontal scaling safe.
