import "dotenv/config";
import { prisma } from "../lib/prisma";
import { getQueue, enqueueMessage, closeQueue, jobIdFor } from "../lib/queue";
import { createLogger } from "../lib/logger";

/**
 * Queue reconciler.
 *
 * BullMQ stores delayed jobs in Redis with AOF persistence, so a normal
 * restart recovers them automatically. This script covers the remaining gaps:
 *
 *   1. A row saved as QUEUED whose job was lost (Redis flushed, volume wiped,
 *      enqueue crashed after commit).
 *   2. A row left in PENDING/QUEUED whose scheduled time has already passed
 *      while no worker was running.
 *   3. Stale SENDING rows from a worker that died mid-send.
 *   4. Orphaned Redis jobs for messages that were cancelled or deleted.
 *
 * Run it after any restart, or on a cron. It is safe to run repeatedly.
 */

const log = createLogger("reconcile");

async function main() {
  const queue = getQueue();

  const now = new Date();

  // --- 1. Rows that should have a job but might not -------------------------
  const candidates = await prisma.scheduledMessage.findMany({
    where: {
      status: { in: ["PENDING", "QUEUED"] },
      scheduledAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) },
    },
    select: { id: true, scheduledAt: true, status: true },
  });

  let enqueued = 0;

  for (const row of candidates) {
    const jobId = jobIdFor(row.id);
    const existing = await queue.getJob(jobId);

    if (existing) continue;

    const delayMs = Math.max(0, row.scheduledAt.getTime() - Date.now());

    await enqueueMessage({
      messageId: row.id,
      scheduledAt: row.scheduledAt,
      delayMs,
    });

    if (row.status === "PENDING") {
      await prisma.scheduledMessage.update({
        where: { id: row.id },
        data: { status: "QUEUED" },
      });
    }

    await prisma.messageEvent.create({
      data: {
        messageId: row.id,
        type: "RE_ENQUEUED",
        detail: { reason: "missing job detected by reconciler", delayMs },
      },
    });

    enqueued++;
    log.info({ messageId: row.id, delayMs }, "Re-enqueued missing job");
  }

  // --- 2. Stale SENDING rows ------------------------------------------------
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  const stale = await prisma.scheduledMessage.updateMany({
    where: { status: "SENDING", lastAttemptAt: { lt: staleBefore } },
    data: { status: "FAILED", failureReason: "Worker stopped mid-send; marked failed by reconciler" },
  });

  if (stale.count > 0) {
    log.warn({ count: stale.count }, "Marked stale SENDING rows as FAILED");
  }

  // --- 3. Orphaned jobs -----------------------------------------------------
  const jobs = await queue.getJobs(["delayed", "waiting"]);
  let orphansRemoved = 0;

  for (const job of jobs) {
    const messageId = (job.data as { messageId?: string })?.messageId;
    if (!messageId) continue;

    const row = await prisma.scheduledMessage.findUnique({
      where: { id: messageId },
      select: { status: true },
    });

    const stillWanted =
      row && (row.status === "PENDING" || row.status === "QUEUED");

    if (!stillWanted) {
      await job.remove();
      orphansRemoved++;
      log.info({ messageId, jobId: job.id }, "Removed orphaned job");
    }
  }

  const counts = await queue.getJobCounts("delayed", "waiting", "active", "failed");

  log.info(
    { enqueued, orphansRemoved, staleMarked: stale.count, queue: counts },
    "Reconciliation complete",
  );

  await closeQueue();
  await prisma.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err }, "Reconciliation failed");
    process.exit(1);
  });
