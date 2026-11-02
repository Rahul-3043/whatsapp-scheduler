import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { createLogger } from "../logger";
import { sendWhatsAppMessage, WhatsAppApiError } from "../whatsapp/client";

/**
 * The send path, extracted from the worker so it can be unit-tested and, if
 * needed later, reused by a different trigger (e.g. an immediate "send now").
 */

const log = createLogger("message-service");

export interface ClaimResult {
  claimed: boolean;
  reason?: "NOT_FOUND" | "NOT_SENDABLE" | "ALREADY_SENDING";
  status?: string;
}

/**
 * Atomically claim a message for sending.
 *
 * The conditional `updateMany` is the core duplicate-send guard. Only the
 * caller that observes the row still in PENDING/QUEUED and flips it to SENDING
 * proceeds; any concurrent worker (or a retried job after a crash) sees zero
 * rows updated and bails out.
 */
export async function claimForSending(messageId: string): Promise<ClaimResult> {
  const message = await prisma.scheduledMessage.findUnique({
    where: { id: messageId },
    select: { id: true, status: true },
  });

  if (!message) return { claimed: false, reason: "NOT_FOUND" };

  // SENDING with a stale lastAttemptAt is recoverable (worker crashed
  // mid-send). Treat anything older than 10 minutes as abandoned so the
  // message is not stuck forever.
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  const claimable =
    message.status === "PENDING" ||
    message.status === "QUEUED" ||
    (message.status === "SENDING" && (await isStale(message.id, staleBefore)));

  if (!claimable) {
    return { claimed: false, reason: "NOT_SENDABLE", status: message.status };
  }

  const updated = await prisma.scheduledMessage.updateMany({
    where: {
      id: messageId,
      status: { in: ["PENDING", "QUEUED", ...(message.status === "SENDING" ? (["SENDING"] as const) : [])] },
    },
    data: {
      status: "SENDING",
      lastAttemptAt: new Date(),
      attemptCount: { increment: 1 },
    },
  });

  if (updated.count === 0) {
    return { claimed: false, reason: "ALREADY_SENDING" };
  }

  return { claimed: true };
}

async function isStale(messageId: string, staleBefore: Date): Promise<boolean> {
  const row = await prisma.scheduledMessage.findUnique({
    where: { id: messageId },
    select: { lastAttemptAt: true },
  });
  return !row?.lastAttemptAt || row.lastAttemptAt < staleBefore;
}

export interface SendOutcome {
  ok: boolean;
  whatsappMessageId?: string;
  retryable?: boolean;
  error?: string;
}

/**
 * Send one claimed message and persist the outcome.
 */
export async function sendClaimedMessage(messageId: string): Promise<SendOutcome> {
  const message = await prisma.scheduledMessage.findUnique({
    where: { id: messageId },
  });

  if (!message) {
    return { ok: false, retryable: false, error: "Message row not found" };
  }

  try {
    const result = await sendWhatsAppMessage({
      to: message.phoneNumber,
      body: message.messageContent,
    });

    await prisma.$transaction([
      prisma.scheduledMessage.update({
        where: { id: messageId },
        data: {
          status: "SENT",
          whatsappMessageId: result.whatsappMessageId,
          sentAt: new Date(),
          failureReason: null,
        },
      }),
      prisma.messageEvent.create({
        data: {
          messageId,
          type: "API_ACCEPTED",
          detail: { whatsappMessageId: result.whatsappMessageId } as Prisma.InputJsonValue,
        },
      }),
    ]);

    log.info(
      { messageId, whatsappMessageId: result.whatsappMessageId },
      "Message sent — awaiting delivery receipt",
    );

    return { ok: true, whatsappMessageId: result.whatsappMessageId };
  } catch (err) {
    const isApiError = err instanceof WhatsAppApiError;
    const retryable = isApiError ? err.retryable : true;

    const reason = isApiError
      ? buildFailureReason(err)
      : err instanceof Error
        ? err.message
        : "Unknown error";

    // Only mark FAILED when we are not going to retry. Otherwise leave the
    // row in SENDING so the BullMQ retry can re-claim it.
    if (!retryable) {
      await prisma.scheduledMessage.update({
        where: { id: messageId },
        data: { status: "FAILED", failureReason: reason },
      });
    }

    await prisma.messageEvent.create({
      data: {
        messageId,
        type: retryable ? "SEND_RETRYABLE_ERROR" : "SEND_FAILED",
        detail: { reason, retryable } as Prisma.InputJsonValue,
      },
    });

    log.error({ messageId, reason, retryable }, "Send failed");

    return { ok: false, retryable, error: reason };
  }
}

function buildFailureReason(err: WhatsAppApiError): string {
  const parts = [err.message];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.subcode) parts.push(`subcode=${err.subcode}`);
  if (err.traceId) parts.push(`trace=${err.traceId}`);
  return parts.join(" | ");
}

/**
 * Final failure handler — called by BullMQ when all attempts are exhausted.
 */
export async function markPermanentlyFailed(
  messageId: string,
  reason: string,
): Promise<void> {
  await prisma.scheduledMessage.updateMany({
    where: { id: messageId, status: { in: ["SENDING", "QUEUED", "PENDING"] } },
    data: { status: "FAILED", failureReason: `Gave up after retries: ${reason}` },
  });
  log.error({ messageId, reason }, "Message permanently failed after retries");
}
