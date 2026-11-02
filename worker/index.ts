import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { getEnv, assertWhatsAppConfigured } from "../lib/env";
import { getRedisConnection, QUEUE_NAME, type SendMessageJob } from "../lib/queue";
import {
  claimForSending,
  sendClaimedMessage,
  markPermanentlyFailed,
} from "../lib/messages/service";
import { createLogger } from "../lib/logger";
import { prisma } from "../lib/prisma";

/**
 * Background worker process.
 *
 * Deliberately separate from Next.js: it owns its own event loop, Redis
 * connection and Prisma client. The web app only enqueues; this process does
 * the sending. Consequences:
 *
 *   - Closing the browser does nothing — the worker keeps running.
 *   - Restarting the web app does nothing — jobs stay in Redis.
 *   - Restarting the worker is safe — BullMQ picks delayed jobs back up from
 *     Redis, and the atomic claim in claimForSending() prevents double sends.
 *
 * Start with:  npm run worker
 */

const log = createLogger("worker");

const env = getEnv();
assertWhatsAppConfigured(env);

const connection = getRedisConnection();

const worker = new Worker<SendMessageJob>(
  QUEUE_NAME,
  async (job: Job<SendMessageJob>) => {
    const { messageId } = job.data;
    const attempt = job.attemptsMade + 1;

    log.info({ messageId, jobId: job.id, attempt }, "Processing scheduled message");

    const claim = await claimForSending(messageId);

    if (!claim.claimed) {
      // Already handled by another run, cancelled, or completed earlier.
      // Returning normally marks the job complete rather than failed, which is
      // correct: there is nothing to retry.
      log.info(
        { messageId, reason: claim.reason, status: claim.status },
        "Skipped — message no longer sendable",
      );
      return { skipped: true, reason: claim.reason };
    }

    const outcome = await sendClaimedMessage(messageId);

    if (!outcome.ok) {
      if (outcome.retryable) {
        // Throwing hands the job back to BullMQ, which applies the exponential
        // backoff. The row stays in SENDING and is re-claimed on the retry.
        throw new Error(outcome.error ?? "Retryable send failure");
      }
      // Non-retryable API errors were already written as FAILED — just finish.
      return { skipped: true, reason: outcome.error };
    }

    return { sent: true, whatsappMessageId: outcome.whatsappMessageId };
  },
  {
    connection,
    // One message at a time keeps ordering predictable and avoids hammering
    // Meta's rate limits. Raise for higher throughput.
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    // Delayed jobs are re-fetched from Redis; stalled jobs are recovered here.
    stalledInterval: 30_000,
    maxStalledCount: 2,
    lockDuration: 60_000,
  },
);

worker.on("completed", (job, result) => {
  log.info({ jobId: job.id, result }, "Job completed");
});

worker.on("failed", async (job, err) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  const isFinal = job.attemptsMade >= maxAttempts;

  log.error(
    { jobId: job.id, attempt: job.attemptsMade, maxAttempts, err: err.message },
    isFinal ? "Job failed permanently" : "Job failed — will retry",
  );

  if (isFinal) {
    await markPermanentlyFailed(job.data.messageId, err.message).catch((e) =>
      log.error({ err: e }, "Could not persist permanent failure"),
    );
  }
});

worker.on("error", (err) => {
  log.error({ err }, "Worker error");
});

// ---------------------------------------------------------------------------
// Graceful shutdown: let in-flight jobs finish before exiting so a restart
// never leaves a message half-sent.
// ---------------------------------------------------------------------------
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ signal }, "Shutting down worker…");

  try {
    await worker.close();
    await connection.quit().catch(() => connection.disconnect());
    await prisma.$disconnect();
    log.info("Worker stopped cleanly");
    process.exit(0);
  } catch (err) {
    log.error({ err }, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log.info(
  {
    queue: QUEUE_NAME,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    timezone: env.APP_TIMEZONE,
    templateMode: env.WHATSAPP_USE_TEMPLATE,
    mode: env.WHATSAPP_USE_TEMPLATE
      ? `template:${env.WHATSAPP_TEMPLATE_NAME}`
      : "free-form text",
  },
  "Worker started, waiting for scheduled messages",
);
