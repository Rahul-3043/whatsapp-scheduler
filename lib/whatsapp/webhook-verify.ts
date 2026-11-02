import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta signs every webhook POST with HMAC-SHA256 over the *raw* request body,
 * keyed by your app secret, and sends it as `X-Hub-Signature-256: sha256=<hex>`.
 *
 * The raw body matters: re-serialising parsed JSON changes the bytes and the
 * signature will not match. Route handlers must read the body as text first.
 */
export function verifyWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  appSecret: string | undefined;
}): { valid: boolean; reason?: string } {
  const { rawBody, signatureHeader, appSecret } = input;

  if (!appSecret) {
    return { valid: false, reason: "WHATSAPP_APP_SECRET is not configured" };
  }
  if (!signatureHeader) {
    return { valid: false, reason: "Missing X-Hub-Signature-256 header" };
  }

  const [algorithm, received] = signatureHeader.split("=");
  if (algorithm !== "sha256" || !received) {
    return { valid: false, reason: "Unsupported signature algorithm" };
  }

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const receivedBuf = Buffer.from(received, "hex");
  const expectedBuf = Buffer.from(expected, "hex");

  if (receivedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: "Signature length mismatch" };
  }
  if (!timingSafeEqual(receivedBuf, expectedBuf)) {
    return { valid: false, reason: "Signature mismatch" };
  }

  return { valid: true };
}
