import { z } from "zod";

/**
 * Centralised, validated environment configuration.
 *
 * Nothing in this file is ever imported by client components — it must stay
 * server-only so the WhatsApp access token can never leak to the browser.
 */

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),

  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_BUSINESS_ACCOUNT_ID: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,

  /**
   * Template mode. Business-initiated conversations outside a 24h customer
   * service window MUST use an approved template. When this is enabled the
   * free-text `messageContent` is passed as the body parameter of the
   * template's single variable ({{1}}).
   */
  WHATSAPP_TEMPLATE_NAME: optionalString,
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().trim().default("en_US"),
  WHATSAPP_USE_TEMPLATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  WHATSAPP_API_VERSION: z.string().trim().default("v21.0"),
  WHATSAPP_GRAPH_BASE_URL: z.string().trim().default("https://graph.facebook.com"),

  /** IANA zone used for all user-facing scheduling/display. */
  APP_TIMEZONE: z.string().trim().default("Asia/Kolkata"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** True when every credential needed to actually call Meta's API is present. */
export function isWhatsAppConfigured(env: Env = getEnv()): boolean {
  return Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

/**
 * Fail fast at worker boot. The worker's whole purpose is sending, so running
 * it without credentials would only produce confusing retry loops.
 */
export function assertWhatsAppConfigured(env: Env = getEnv()): void {
  const missing: string[] = [];
  if (!env.WHATSAPP_ACCESS_TOKEN) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!env.WHATSAPP_PHONE_NUMBER_ID) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (env.WHATSAPP_USE_TEMPLATE && !env.WHATSAPP_TEMPLATE_NAME) {
    missing.push("WHATSAPP_TEMPLATE_NAME (required when WHATSAPP_USE_TEMPLATE=true)");
  }
  if (missing.length > 0) {
    throw new Error(
      `Worker cannot start — missing WhatsApp credentials:\n${missing
        .map((m) => `  - ${m}`)
        .join("\n")}\nAdd them to .env (see .env.example).`,
    );
  }
}
