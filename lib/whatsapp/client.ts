import { getEnv } from "../env";
import { createLogger } from "../logger";

/**
 * Minimal, typed client for Meta's WhatsApp Cloud API.
 *
 * Only the official Graph API is used — no unofficial libraries, no browser
 * automation. Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const log = createLogger("whatsapp-api");

export interface SendResult {
  /** Meta's message id ("wamid...."). */
  whatsappMessageId: string;
  /** Raw provider response body, for audit logging. */
  raw: unknown;
}

export class WhatsAppApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly traceId?: string;
  readonly retryable: boolean;
  readonly raw: unknown;

  constructor(opts: {
    message: string;
    status: number;
    code?: number;
    subcode?: number;
    type?: string;
    traceId?: string;
    retryable: boolean;
    raw: unknown;
  }) {
    super(opts.message);
    this.name = "WhatsAppApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.subcode = opts.subcode;
    this.type = opts.type;
    this.traceId = opts.traceId;
    this.retryable = opts.retryable;
    this.raw = opts.raw;
  }
}

type MetaErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
};

/**
 * Normalise any phone input to the digits-only form the Cloud API expects
 * (no `+`, no separators).
 */
export function normalizePhoneForApi(phone: string): string {
  return phone.replace(/\D/g, "");
}

function looksLikeCheckoutRequirement(status: number, code?: number): boolean {
  // 131030 = recipient not in allowed list (test number mode)
  return status === 400 && code === 131030;
}

/**
 * Send a WhatsApp message.
 *
 * Two modes, controlled by WHATSAPP_USE_TEMPLATE:
 *
 *  - free-form text  — only valid inside an open 24-hour customer service
 *                      window. Good for local testing with your own number.
 *  - template        — required for business-initiated messages that fall
 *                      outside that window. The user's text becomes the
 *                      body parameter {{1}} of an approved template.
 */
export async function sendWhatsAppMessage(input: {
  to: string;
  body: string;
}): Promise<SendResult> {
  const env = getEnv();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID!;
  const url = `${env.WHATSAPP_GRAPH_BASE_URL}/${env.WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;
  const to = normalizePhoneForApi(input.to);

  const payload = env.WHATSAPP_USE_TEMPLATE
    ? buildTemplatePayload(to, input.body, env)
    : buildTextPayload(to, input.body);

  log.info(
    { to: maskPhone(to), mode: payload.type, template: env.WHATSAPP_TEMPLATE_NAME },
    "Sending WhatsApp message",
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new WhatsAppApiError({
      message: aborted
        ? "WhatsApp API request timed out after 20s"
        : `Network error calling WhatsApp API: ${(err as Error).message}`,
      status: 0,
      retryable: true,
      raw: { cause: (err as Error).message },
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const errBody = parsed as MetaErrorBody;
    const err = errBody?.error;
    const code = err?.code;

    // 4xx (except rate limiting / transient 429) means retrying is pointless —
    // a bad token, unapproved template, or invalid recipient will not fix itself.
    const retryable =
      response.status === 429 ||
      response.status >= 500;

    const detail =
      err?.error_user_msg ||
      err?.message ||
      `HTTP ${response.status} ${response.statusText}`;

    throw new WhatsAppApiError({
      message: looksLikeCheckoutRequirement(response.status, code)
        ? `${detail} — this recipient is not in the allowed list for a test number. Add it in Meta Business Suite or use a live number.`
        : detail,
      status: response.status,
      code,
      subcode: err?.error_subcode,
      type: err?.type,
      traceId: err?.fbtrace_id,
      retryable,
      raw: parsed,
    });
  }

  const messages = (parsed as { messages?: Array<{ id?: string }> })?.messages;
  const whatsappMessageId = messages?.[0]?.id;

  if (!whatsappMessageId) {
    // A 200 without a message id is not something we can track or dedupe on.
    throw new WhatsAppApiError({
      message: "WhatsApp API accepted the request but returned no message id",
      status: response.status,
      retryable: false,
      raw: parsed,
    });
  }

  log.info({ whatsappMessageId, to: maskPhone(to) }, "WhatsApp API accepted message");

  return { whatsappMessageId, raw: parsed };
}

function buildTextPayload(to: string, body: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body },
  };
}

function buildTemplatePayload(
  to: string,
  body: string,
  env: ReturnType<typeof getEnv>,
) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: env.WHATSAPP_TEMPLATE_NAME,
      language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: body }],
        },
      ],
    },
  };
}

/** Keep phone numbers out of logs in full. */
export function maskPhone(phone: string): string {
  const digits = normalizePhoneForApi(phone);
  if (digits.length <= 4) return "****";
  return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
}
