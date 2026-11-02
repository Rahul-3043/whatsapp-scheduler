import { Prisma, type MessageStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { createLogger } from "../logger";

/**
 * Applying WhatsApp status updates safely.
 *
 * Three rules make this correct under real webhook traffic:
 *
 * 1. Idempotency — Meta retries webhooks and can deliver them out of order.
 *    Every event is recorded in `MessageEvent` with its provider event id and a
 *    unique constraint on (messageId, providerEventId), so a repeat is a no-op.
 *
 * 2. Monotonicity — statuses only move forward:
 *        SENT -> DELIVERED -> READ
 *    A late "SENT" arriving after "READ" must never downgrade the row.
 *
 * 3. Timestamps are written once — a second DELIVERED event does not overwrite
 *    the original deliveredAt.
 */

const log = createLogger("whatsapp-status");

/** Rank used to enforce forward-only transitions. Higher = further along. */
const STATUS_RANK: Record<MessageStatus, number> = {
  PENDING: 0,
  QUEUED: 1,
  SENDING: 2,
  SENT: 3,
  DELIVERED: 4,
  READ: 5,
  // Terminal-but-not-ordinal outcomes are ranked below every progress state
  // and handled separately.
  FAILED: -1,
  CANCELED: -1,
};

export type WebhookStatus = "sent" | "delivered" | "read" | "failed" | "deleted";

export interface StatusEventInput {
  whatsappMessageId: string;
  status: WebhookStatus;
  /** Unix seconds from the webhook payload. */
  timestamp?: number;
  /** Meta's error object on failed events. */
  error?: { code?: number; title?: string; message?: string; error_data?: { details?: string } };
  /** Stable id for this webhook event, when the payload offers one. */
  providerEventId?: string | null;
  raw?: unknown;
}

export interface StatusEventResult {
  applied: boolean;
  reason?: string;
  status?: MessageStatus;
}

function eventTime(timestamp?: number): Date {
  if (timestamp && Number.isFinite(timestamp)) return new Date(timestamp * 1000);
  return new Date();
}

function mapStatus(status: WebhookStatus): MessageStatus | null {
  switch (status) {
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    case "deleted":
      // Meta emits this when the user deletes the message. There is no
      // dedicated status for it; keep the current status but audit the event.
      return null;
    default:
      return null;
  }
}

function failureReason(error: StatusEventInput["error"]): string {
  if (!error) return "Delivery failed (no error details provided by WhatsApp)";
  return (
    error.error_data?.details ??
    error.message ??
    error.title ??
    `WhatsApp error code ${error.code ?? "unknown"}`
  );
}

/**
 * Apply one status event. Safe to call repeatedly with the same event.
 */
export async function applyStatusEvent(
  input: StatusEventInput,
): Promise<StatusEventResult> {
  const target = mapStatus(input.status);

  const message = await prisma.scheduledMessage.findUnique({
    where: { whatsappMessageId: input.whatsappMessageId },
    select: {
      id: true,
      status: true,
      sentAt: true,
      deliveredAt: true,
      readAt: true,
      failureReason: true,
    },
  });

  if (!message) {
    log.warn(
      { whatsappMessageId: input.whatsappMessageId, status: input.status },
      "Webhook status for unknown message id — ignored",
    );
    return { applied: false, reason: "UNKNOWN_MESSAGE_ID" };
  }

  const occurredAt = eventTime(input.timestamp);

  // Audit row first: the unique (messageId, providerEventId) constraint is
  // what makes duplicate webhook deliveries harmless.
  try {
    await prisma.messageEvent.create({
      data: {
        messageId: message.id,
        type: `WEBHOOK_${input.status.toUpperCase()}`,
        providerEventId: input.providerEventId ?? null,
        detail: (input.raw ?? undefined) as Prisma.InputJsonValue | undefined,
        createdAt: occurredAt,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      log.info(
        { whatsappMessageId: input.whatsappMessageId, status: input.status },
        "Duplicate webhook event — skipped",
      );
      return { applied: false, reason: "DUPLICATE_EVENT", status: message.status };
    }
    throw err;
  }

  if (!target) {
    log.info(
      { whatsappMessageId: input.whatsappMessageId, status: input.status },
      "Status requires no column update (audited only)",
    );
    return { applied: false, reason: "NO_STATE_CHANGE", status: message.status };
  }

  const data: Prisma.ScheduledMessageUpdateInput = {};
  let reason: string | undefined;

  if (target === "FAILED") {
    // A failure can arrive after READ (rare, but Meta does not guarantee order).
    // Never regress a delivered/read message.
    if (STATUS_RANK[message.status] >= STATUS_RANK.DELIVERED) {
      reason = "REGRESSION_BLOCKED";
    } else {
      data.status = "FAILED";
      data.failureReason = failureReason(input.error);
    }
  } else if (STATUS_RANK[target] > STATUS_RANK[message.status]) {
    data.status = target;

    // Write each timestamp exactly once.
    if (target === "SENT" && !message.sentAt) data.sentAt = occurredAt;
    if (target === "DELIVERED" && !message.deliveredAt) data.deliveredAt = occurredAt;
    if (target === "READ" && !message.readAt) data.readAt = occurredAt;

    // A read receipt implies delivery even if the DELIVERED webhook was lost.
    if (target === "READ" && !message.deliveredAt) data.deliveredAt = occurredAt;
  } else {
    reason = "NOT_FORWARD";
  }

  if (reason) {
    log.info(
      {
        whatsappMessageId: input.whatsappMessageId,
        current: message.status,
        incoming: target,
        reason,
      },
      "Status transition skipped",
    );
    return { applied: false, reason, status: message.status };
  }

  /**
   * Guard the update with the status we read, so two webhooks processed
   * concurrently cannot both win. `updateMany` returns the number of rows
   * actually changed.
   */
  const result = await prisma.scheduledMessage.updateMany({
    where: { id: message.id, status: message.status },
    data,
  });

  if (result.count === 0) {
    log.info(
      { whatsappMessageId: input.whatsappMessageId, target },
      "Concurrent status update — skipped",
    );
    return { applied: false, reason: "CONCURRENT_UPDATE", status: message.status };
  }

  log.info(
    {
      whatsappMessageId: input.whatsappMessageId,
      from: message.status,
      to: data.status ?? message.status,
    },
    "Message status updated",
  );

  return { applied: true, status: (data.status as MessageStatus) ?? message.status };
}
