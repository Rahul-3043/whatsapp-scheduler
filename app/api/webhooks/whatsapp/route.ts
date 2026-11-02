import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { verifyWebhookSignature } from "@/lib/whatsapp/webhook-verify";
import { applyStatusEvent, type WebhookStatus } from "@/lib/whatsapp/status";
import { createLogger } from "@/lib/logger";

const log = createLogger("webhook:whatsapp");

/**
 * Meta WhatsApp Cloud API webhook.
 *
 *  GET  — subscription handshake. Meta calls this once when you save the
 *         callback URL, and expects the raw `hub.challenge` echoed back.
 *  POST — status events (sent / delivered / read / failed).
 */

/** GET /api/webhooks/whatsapp — verification challenge. */
export async function GET(request: NextRequest) {
  const env = getEnv();
  const params = request.nextUrl.searchParams;

  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe") {
    log.warn({ mode }, "Webhook verification called with unexpected mode");
    return new NextResponse("Unsupported mode", { status: 400 });
  }

  if (!env.WHATSAPP_VERIFY_TOKEN) {
    log.error("WHATSAPP_VERIFY_TOKEN is not configured — cannot verify webhook");
    return new NextResponse("Verification token not configured", { status: 500 });
  }

  if (!token || token !== env.WHATSAPP_VERIFY_TOKEN) {
    log.warn("Webhook verification failed — token mismatch");
    return new NextResponse("Forbidden", { status: 403 });
  }

  log.info("Webhook verified successfully");
  // Must be the raw challenge string, not JSON.
  return new NextResponse(challenge ?? "", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

/** POST /api/webhooks/whatsapp — status updates. */
export async function POST(request: NextRequest) {
  const env = getEnv();

  // Read the RAW body: the HMAC is computed over these exact bytes.
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  const verification = verifyWebhookSignature({
    rawBody,
    signatureHeader: signature,
    appSecret: env.WHATSAPP_APP_SECRET,
  });

  if (!verification.valid) {
    // Reject unverified payloads — otherwise anyone who learns the URL could
    // forge "READ" receipts.
    log.warn({ reason: verification.reason }, "Rejected webhook: invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Always 200 quickly after processing so Meta does not retry. Genuine errors
  // are logged; a non-200 only makes Meta redeliver the same payload.
  try {
    const processed = await handlePayload(payload);
    log.info(processed, "Webhook processed");
  } catch (err) {
    log.error({ err }, "Error processing webhook payload");
  }

  return NextResponse.json({ received: true });
}

interface WebhookValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  statuses?: Array<{
    id?: string;
    status?: string;
    timestamp?: string;
    recipient_id?: string;
    conversation?: unknown;
    pricing?: unknown;
    errors?: Array<{
      code?: number;
      title?: string;
      message?: string;
      error_data?: { details?: string };
    }>;
  }>;
  messages?: unknown[];
}

async function handlePayload(payload: unknown) {
  const body = payload as {
    object?: string;
    entry?: Array<{
      id?: string;
      changes?: Array<{ field?: string; value?: WebhookValue }>;
    }>;
  };

  if (body?.object !== "whatsapp_business_account") {
    return { ignored: true, reason: "not a whatsapp_business_account event" };
  }

  let applied = 0;
  let skipped = 0;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value?.statuses?.length) continue;

      for (const status of value.statuses) {
        if (!status.id || !status.status) continue;

        // Build a stable event id so a redelivered webhook is deduped.
        // Meta's status webhooks carry no event id, so we derive one from
        // (message id, status, timestamp) — unique per real transition.
        const providerEventId = `${status.id}:${status.status}:${status.timestamp ?? "0"}`;

        const result = await applyStatusEvent({
          whatsappMessageId: status.id,
          status: status.status as WebhookStatus,
          timestamp: status.timestamp ? Number(status.timestamp) : undefined,
          error: status.errors?.[0],
          providerEventId,
          raw: status as unknown,
        });

        if (result.applied) applied++;
        else skipped++;
      }
    }
  }

  return { applied, skipped };
}
