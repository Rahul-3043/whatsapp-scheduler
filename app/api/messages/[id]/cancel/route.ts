import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { removeQueuedJob } from "@/lib/queue";
import { createLogger } from "@/lib/logger";

const log = createLogger("api:cancel");

/**
 * POST /api/messages/:id/cancel
 * Cancel a pending scheduled message.
 *
 * Order matters: cancel in the database *first*, then remove the queue job.
 * If the process dies in between, a surviving job will fire but the worker's
 * status guard sees CANCELED and refuses to send. The reverse order could
 * leave a row that says QUEUED with no job to ever send it.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const message = await prisma.scheduledMessage.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  // Only not-yet-sent messages can be cancelled. SENT/DELIVERED/READ are
  // final — WhatsApp offers no recall for business messages.
  const cancellable = ["PENDING", "QUEUED"];
  if (!cancellable.includes(message.status)) {
    return NextResponse.json(
      {
        error: `Cannot cancel a message with status ${message.status}. Only PENDING or QUEUED messages can be cancelled.`,
        status: message.status,
      },
      { status: 409 },
    );
  }

  // Conditional update: whoever flips it out of PENDING/QUEUED wins. This also
  // prevents racing the worker, which claims rows the same way.
  const updated = await prisma.scheduledMessage.updateMany({
    where: { id, status: { in: ["PENDING", "QUEUED"] } },
    data: { status: "CANCELED", failureReason: null },
  });

  if (updated.count === 0) {
    return NextResponse.json(
      {
        error: "Message could not be cancelled — its status changed. Refresh and try again.",
      },
      { status: 409 },
    );
  }

  await prisma.messageEvent.create({
    data: { messageId: id, type: "CANCELED", detail: { previousStatus: message.status } },
  });

  let jobRemoved = false;
  try {
    jobRemoved = await removeQueuedJob(id);
  } catch (err) {
    // The row is already CANCELED, so a leftover job is harmless — the worker
    // will skip it. Log rather than fail the request.
    log.warn({ err, messageId: id }, "Could not remove queued job");
  }

  log.info({ messageId: id, jobRemoved }, "Message cancelled");

  return NextResponse.json({
    message: { id, status: "CANCELED" },
    jobRemoved,
  });
}
