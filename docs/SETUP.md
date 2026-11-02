# Local Setup

Everything below assumes an Ubuntu machine with the project at
`~/whatsapp-scheduler`.

---

## 0. Prerequisites

| Tool | Check | Notes |
|---|---|---|
| Node.js 20+ | `node -v` | Built and tested on Node 22 |
| PostgreSQL 16 | `pg_isready` | Already installed and running on `:5432` |
| Docker | `docker --version` | Used **only** for Redis |
| Docker Compose | `docker compose version` | v2 syntax |

---

## 1. Database (existing PostgreSQL 16)

Create a dedicated, least-privilege role and database. Do **not** run the app
as the `postgres` superuser.

```bash
sudo -u postgres psql \
  -c "CREATE ROLE whatsapp WITH LOGIN PASSWORD 'YourStrongPassword123';" \
  -c "CREATE DATABASE whatsapp_scheduler OWNER whatsapp;"
```

Verify:

```bash
PGPASSWORD='YourStrongPassword123' psql -h localhost -U whatsapp -d whatsapp_scheduler \
  -c "select current_user, current_database();"
```

That role owns the database, so Prisma can create tables and types without
extra grants.

---

## 2. Redis (Docker Compose)

Redis is not installed natively on this machine, so Compose runs it.

```bash
cd ~/whatsapp-scheduler
docker compose up -d
```

Check it:

```bash
docker compose ps
docker exec whatsapp-scheduler-redis redis-cli ping   # -> PONG
```

Redis persists queued jobs to a named volume with AOF enabled
(`appendonly yes`, `appendfsync everysec`), so a Redis restart does not lose
delayed jobs.

Stop it with `docker compose down` (data survives) or
`docker compose down -v` (wipes the queue).

> **Do not** add PostgreSQL to this compose file — the project deliberately
> reuses your native instance.

---

## 3. Environment

```bash
cp .env.example .env
```

Fill in at minimum:

```ini
DATABASE_URL="postgresql://whatsapp:YourStrongPassword123@localhost:5432/whatsapp_scheduler?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
APP_TIMEZONE="Asia/Kolkata"
```

WhatsApp credentials are covered in `docs/WHATSAPP.md`. The app and the
worker both read `.env`; the worker validates credentials at boot and exits
with a clear message if they are missing.

---

## 4. Install and migrate

```bash
npm install
npx prisma migrate dev --name init   # creates tables + generates the client
```

`prisma generate` runs automatically after `migrate dev`. To regenerate the
client alone:

```bash
npm run db:generate
```

Inspect data:

```bash
npm run db:studio
```

---

## 5. Run

The app and the worker are **two separate processes**. Use two terminals.

**Terminal 1 — web app**

```bash
npm run dev
```

Open <http://localhost:3000>.

**Terminal 2 — background worker**

```bash
npm run worker
```

`npm run worker` uses `tsx watch`, so edits restart it automatically. For a
non-watching run use `npm run worker:prod`.

> The worker is not optional. Without it, messages are queued but never sent.

---

## 6. Verify the wiring

```bash
curl -s localhost:3000/api/health | jq
```

Expected shape:

```json
{
  "status": "ok",
  "timezone": "Asia/Kolkata",
  "checks": {
    "database": { "ok": true },
    "redis": { "ok": true },
    "whatsapp": { "ok": true, "mode": "free-form text", "appSecretConfigured": true }
  }
}
```

`status: "degraded"` means Postgres or Redis is unreachable — the individual
`ok` flags tell you which.

---

## 7. Webhook tunnel

Meta must reach your laptop over HTTPS. Use a tunnel:

```bash
# Option A — cloudflared (no account needed for quick tunnels)
cloudflared tunnel --url http://localhost:3000

# Option B — ngrok
ngrok http 3000
```

Note the public HTTPS URL and configure it in Meta
(see `docs/WHATSAPP.md`). Update the URL in Meta whenever the tunnel restarts,
because quick-tunnel hostnames change.

---

## 8. Restarting safely

After restarting Postgres, Redis, or the worker, run the reconciler:

```bash
npm run reconcile
```

It re-enqueues any QUEUED row whose Redis job is missing, marks abandoned
`SENDING` rows as failed, and deletes orphaned jobs for cancelled messages.
It is idempotent — safe to run at any time, or from cron.

BullMQ recovers delayed jobs from Redis on its own; the reconciler only covers
lost-job and crash-recovery edge cases.

---

## 9. Common problems

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:6379` | Redis not running | `docker compose up -d` |
| API returns 503 "scheduler could not be reached" | Redis down at enqueue time | Start Redis, then `npm run reconcile` |
| Message stuck at `QUEUED` past its time | Worker not running | `npm run worker` |
| `Worker cannot start — missing WhatsApp credentials` | `.env` incomplete | Fill in the WhatsApp vars |
| Webhook returns 401 | `WHATSAPP_APP_SECRET` wrong/empty, or body was re-serialised | Set the correct app secret |
| Webhook never arrives | Tunnel URL changed / not subscribed | Re-subscribe in Meta |
| `P1001: Can't reach database server` | Wrong `DATABASE_URL` host/port | Check `pg_isready` |
| Status stuck at `SENT`, never `DELIVERED` | Webhook not configured, or recipient is offline | Check the webhook subscription and tunnel logs |
