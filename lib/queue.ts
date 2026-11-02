import { Queue, type JobsOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { getEnv } from "./env";
import { createLogger } from "./logger";

/**
 * Shared Redis connection + the single message-scheduling queue.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses for
 * blocking commands — that is why the options below are not the ioredis
 * defaults.
 */

const log = createLogger("queue");

export const QUEUE_NAME = "whatsapp-messages";
export const JOB_NAME = "send-whatsapp-message";

/** Payload stored in Redis for each delayed job. */
export interface SendMessageJob {
  messageId: string;
}

/**
 * Stable job id: one delayed job per database row, enforced by Redis.
 *
 * BullMQ rejects custom ids containing `:` (it reserves that separator for its
 * own keys), so the prefix uses `-` instead.
 */
export function jobIdFor(messageId: string): string {
  return `msg-${messageId}`;
}

let connection: Redis | null = null;
let queue: Queue<SendMessageJob> | null = null;

/**
 * Connections are cached on `globalThis` so Next.js hot reload and per-request
 * module instantiation don't leak sockets.
 */
const globalForQueue = globalThis as unknown as {
  __redis?: Redis;
  __queue?: Queue<SendMessageJob>;
};

export function getRedisConnection(): Redis {
  if (globalForQueue.__redis) return globalForQueue.__redis;

  const url = getEnv().REDIS_URL;
  const client = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Keep trying — Redis may start slightly after the app in local dev.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  client.on("error", (err) => log.error({ err }, "Redis connection error"));
  client.on("ready", () => log.info({ url: redactUrl(url) }, "Redis connected"));

  globalForQueue.__redis = client;
  connection = client;
  return client;
}

export function getQueue(): Queue<SendMessageJob> {
  if (globalForQueue.__queue) return globalForQueue.__queue;

  const q = new Queue<SendMessageJob>(QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: defaultJobOptions(),
  });

  globalForQueue.__queue = q;
  queue = q;
  return q;
}

function defaultJobOptions(): JobsOptions {
  return {
    attempts: 3,
    // 1 min, 5 min, 15 min between retries.
    backoff: { type: "exponential", delay: 60_000 },
    // Keep completed/failed jobs for a week so we can audit them.
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
  };
}

/**
 * Enqueue (or re-enqueue) the delayed send for a message.
 *
 * The deterministic `jobId` is the idempotency key: scheduling the same
 * message twice updates the existing job rather than creating a second one, so
 * a user double-clicking "Schedule" can never produce two sends.
 */
export async function enqueueMessage(input: {
  messageId: string;
  scheduledAt: Date;
  delayMs: number;
}): Promise<{ jobId: string; delayMs: number }> {
  const q = getQueue();
  const jobId = jobIdFor(input.messageId);

  await q.add(
    JOB_NAME,
    { messageId: input.messageId },
    {
      jobId,
      delay: input.delayMs,
      // Job-level override wins over defaults; keeps ordering explicit.
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
    },
  );

  log.info(
    { messageId: input.messageId, jobId, delayMs: input.delayMs },
    "Message enqueued",
  );

  return { jobId, delayMs: input.delayMs };
}

/**
 * Remove a not-yet-starting job. Returns true when a job was actually removed.
 * Jobs already active are left alone — the worker's status guard handles those.
 */
export async function removeQueuedJob(messageId: string): Promise<boolean> {
  const q = getQueue();
  const jobId = jobIdFor(messageId);
  const job = await q.getJob(jobId);
  if (!job) return false;

  const state = await job.getState();
  if (state === "active") {
    log.warn({ messageId, jobId }, "Job already active; cannot unschedule");
    return false;
  }

  await job.remove();
  log.info({ messageId, jobId, state }, "Queued job removed");
  return true;
}

/** Close sockets — used by scripts and graceful shutdown. */
export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
    globalForQueue.__queue = undefined;
  }
  if (connection) {
    await connection.quit().catch(() => connection?.disconnect());
    connection = null;
    globalForQueue.__redis = undefined;
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}
