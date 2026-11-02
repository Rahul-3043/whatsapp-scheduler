import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { formatInAppTimezone, utcToLocalParts, appTimezone } from "@/lib/time";

/**
 * GET /api/messages/:id
 * Full status of one message, including delivery and read receipts.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const message = await prisma.scheduledMessage.findUnique({
    where: { id },
    include: {
      events: {
        orderBy: { createdAt: "asc" },
        select: { type: true, createdAt: true, detail: true },
      },
    },
  });

  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  return NextResponse.json({
    timezone: appTimezone(),
    message: {
      id: message.id,
      recipientName: message.recipientName,
      phoneNumber: message.phoneNumber,
      messageContent: message.messageContent,
      scheduledAt: message.scheduledAt.toISOString(),
      scheduledAtLabel: formatInAppTimezone(message.scheduledAt),
      scheduledAtLocal: utcToLocalParts(message.scheduledAt),
      status: message.status,
      // Never infer read from API success — this reflects only webhook data.
      readStatus: describeReadStatus(message),
      whatsappMessageId: message.whatsappMessageId,
      sentAt: message.sentAt?.toISOString() ?? null,
      deliveredAt: message.deliveredAt?.toISOString() ?? null,
      readAt: message.readAt?.toISOString() ?? null,
      failureReason: message.failureReason,
      attemptCount: message.attemptCount,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
      events: message.events.map((e) => ({
        type: e.type,
        at: e.createdAt.toISOString(),
        detail: e.detail,
      })),
    },
  });
}

/**
 * Read receipts are optional on WhatsApp: the recipient can disable them, and
 * some clients never send them. "Unknown" is the honest answer when we have
 * no read webhook — never "unread".
 */
function describeReadStatus(m: {
  status: string;
  readAt: Date | null;
  deliveredAt: Date | null;
}): { state: "READ" | "DELIVERED_NOT_READ" | "UNKNOWN"; label: string } {
  if (m.readAt) {
    return { state: "READ", label: `Read at ${formatInAppTimezone(m.readAt)}` };
  }
  if (m.deliveredAt) {
    return {
      state: "DELIVERED_NOT_READ",
      label:
        "Delivered, but no read receipt received yet. The recipient may have read receipts turned off, or has not opened it.",
    };
  }
  return {
    state: "UNKNOWN",
    label: "Read status unknown — message has not been delivered yet.",
  };
}
