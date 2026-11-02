import { z } from "zod";

/**
 * Request validation + sanitisation.
 *
 * Every string is trimmed and length-capped so that nothing unbounded reaches
 * the database or the WhatsApp API.
 */

/** E.164: optional leading +, 8–15 digits, first digit 1–9. */
const E164 = /^\+?[1-9]\d{7,14}$/;

export const createMessageSchema = z.object({
  recipientName: z
    .string()
    .trim()
    .min(1, "Recipient name is required")
    .max(120, "Recipient name must be 120 characters or fewer"),

  phoneNumber: z
    .string()
    .trim()
    .min(1, "Mobile number is required")
    .transform((v) => v.replace(/[\s\-().]/g, ""))
    .refine((v) => E164.test(v), {
      message:
        "Enter the number with country code, digits only (e.g. +919876543210)",
    }),

  messageContent: z
    .string()
    .trim()
    .min(1, "Message content is required")
    .max(4096, "Message must be 4096 characters or fewer"),

  /** ISO calendar date in the app timezone, e.g. "2026-11-05". */
  scheduledDate: z
    .string()
    .trim()
    .min(1, "Scheduled date is required")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Scheduled date must be YYYY-MM-DD"),

  /** 24-hour clock in the app timezone, e.g. "09:30". */
  scheduledTime: z
    .string()
    .trim()
    .min(1, "Scheduled time is required")
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Scheduled time must be HH:mm (24-hour)"),
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const listQuerySchema = z.object({
  status: z
    .enum([
      "PENDING",
      "QUEUED",
      "SENDING",
      "SENT",
      "DELIVERED",
      "READ",
      "FAILED",
      "CANCELED",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Flatten a ZodError into `{ field: "message" }` for the UI.
 *
 * Zod v4 emits developer-facing text for type mismatches ("Invalid input:
 * expected string, received undefined"). Those leak into the form, so they are
 * replaced with a plain-language message.
 */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    if (out[key]) continue;

    const missing = issue.code === "invalid_type" && issue.message.includes("undefined");
    const notString = issue.code === "invalid_type" && issue.message.includes("expected string");

    if (missing) {
      out[key] = `${labelFor(key)} is required`;
    } else if (notString) {
      out[key] = `${labelFor(key)} must be text`;
    } else {
      out[key] = issue.message;
    }
  }

  return out;
}

function labelFor(field: string): string {
  const labels: Record<string, string> = {
    recipientName: "Recipient name",
    phoneNumber: "Mobile number",
    messageContent: "Message",
    scheduledDate: "Scheduled date",
    scheduledTime: "Scheduled time",
    form: "Request",
  };
  return labels[field] ?? field;
}
