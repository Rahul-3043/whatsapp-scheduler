import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  createMessageSchema,
  listQuerySchema,
  fieldErrors,
} from "@/lib/validation";
import { localToUtc, formatInAppTimezone, utcToLocalParts, appTimezone } from "@/lib/time";
import { enqueueMessage } from "@/lib/queue";
import { createLogger } from "@/lib/logger";

const log = createLogger("api:messages");

/**
 * GET /api/messages
 * List scheduled and previously sent messages, newest scheduled first.
 * Optional: ?status=PENDING&limit=50
 */
export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listQuerySchema.safeParse(params);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", fields: fieldErrors(parsed.error) },
      { status: 400 },
    );
  }

  const { status, limit } = parsed.data;

  const messages = await prisma.scheduledMessage.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ scheduledAt: "desc" }],
    take: limit,
    select: {
      id: true,
      recipientName: true,
      phoneNumber: true,
      messageContent: true,
      scheduledAt: true,
      status: true,
      whatsappMessageId: true,
      sentAt: true,
      deliveredAt: true,
      readAt: true,
      failureReason: true,
      attemptCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    timezone: appTimezone(),
    count: messages.length,
    messages: messages.map(serialize),
  });
}

/**
 * POST /api/messages
 * Create a scheduled message and enqueue its delayed send job.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const parsed = createMessageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please fix the highlighted fields", fields: fieldErrors(parsed.error) },
      { status: 400 },
    );
  }

  const input = parsed.data;

  // Combine the wall-clock date + time in Asia/Kolkata into a UTC instant.
  const converted = localToUtc({
    date: input.scheduledDate,
    time: input.scheduledTime,
  });

  if (!converted.ok) {
    return NextResponse.json(
      { error: converted.error, fields: { scheduledDate: converted.error } },
      { status: 400 },
    );
  }

  const scheduledAt = converted.utc;

  if (scheduledAt.getTime() <= Date.now()) {
    return NextResponse.json(
      {
        error: "Scheduled time must be in the future",
        fields: { scheduledTime: "Choose a date and time later than now" },
      },
      { status: 400 },
    );
  }

  // 1. Persist first. A row without a queue job is recoverable (the
  //    reconciler re-enqueues it); a queue job without a row is not.
  const message = await prisma.scheduledMessage.create({
    data: {
      recipientName: input.recipientName,
      phoneNumber: input.phoneNumber,
      messageContent: input.messageContent,
      scheduledAt,
      status: "PENDING",
    },
  });

  const delayMs = scheduledAt.getTime() - Date.now();

  try {
    await enqueueMessage({ messageId: message.id, scheduledAt, delayMs });

    await prisma.$transaction([
      prisma.scheduledMessage.update({
        where: { id: message.id },
        data: { status: "QUEUED" },
      }),
      prisma.messageEvent.create({
        data: {
          messageId: message.id,
          type: "QUEUED",
          detail: {
            delayMs,
            scheduledAtUtc: scheduledAt.toISOString(),
            timezone: appTimezone(),
          },
        },
      }),
    ]);
  } catch (err) {
    // The row exists but no job does. Mark it FAILED with a clear reason so it
    // is visible in the UI instead of silently never sending.
    const reason = err instanceof Error ? err.message : "Could not enqueue job";
    log.error({ err, messageId: message.id }, "Enqueue failed");

    await prisma.scheduledMessage.update({
      where: { id: message.id },
      data: { status: "FAILED", failureReason: `Scheduling failed: ${reason}` },
    });

    return NextResponse.json(
      {
        error:
          "Message was saved but the scheduler could not be reached. Is Redis running? Check that the worker is started.",
        messageId: message.id,
      },
      { status: 503 },
    );
  }

  log.info(
    { messageId: message.id, scheduledAt: scheduledAt.toISOString(), delayMs },
    "Message scheduled",
  );

  const local = utcToLocalParts(scheduledAt);

  return NextResponse.json(
    {
      message: {
        id: message.id,
        recipientName: message.recipientName,
        phoneNumber: message.phoneNumber,
        messageContent: message.messageContent,
        status: "QUEUED",
        scheduledAt: scheduledAt.toISOString(),
        scheduledAtLocal: local,
        scheduledAtLabel: formatInAppTimezone(scheduledAt),
        timezone: appTimezone(),
      },
    },
    { status: 201 },
  );
}

/** Shape returned to the client — no internal fields, ISO timestamps. */
function serialize(m: {
  id: string;
  recipientName: string;
  phoneNumber: string;
  messageContent: string;
  scheduledAt: Date;
  status: string;
  whatsappMessageId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failureReason: string | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: m.id,
    recipientName: m.recipientName,
    phoneNumber: m.phoneNumber,
    messageContent: m.messageContent,
    scheduledAt: m.scheduledAt.toISOString(),
    scheduledAtLabel: formatInAppTimezone(m.scheduledAt),
    scheduledAtLocal: utcToLocalParts(m.scheduledAt),
    status: m.status,
    whatsappMessageId: m.whatsappMessageId,
    sentAt: m.sentAt?.toISOString() ?? null,
    deliveredAt: m.deliveredAt?.toISOString() ?? null,
    readAt: m.readAt?.toISOString() ?? null,
    failureReason: m.failureReason,
    attemptCount: m.attemptCount,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}
