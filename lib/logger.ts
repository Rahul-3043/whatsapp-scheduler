import pino from "pino";

/**
 * Structured JSON logging. In development we pretty-print to keep the
 * terminal readable; in production we emit raw JSON for log aggregators.
 */
const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "whatsapp-scheduler" },
  redact: {
    paths: [
      "*.WHATSAPP_ACCESS_TOKEN",
      "*.accessToken",
      "*.authorization",
      "req.headers.authorization",
      "req.headers['x-hub-signature-256']",
    ],
    censor: "[REDACTED]",
  },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" },
        },
      }
    : {}),
});

/** Bind a logger to a component, e.g. `const log = logger.child({ component: "worker" })`. */
export function createLogger(component: string) {
  return logger.child({ component });
}
