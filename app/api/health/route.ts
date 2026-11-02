import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedisConnection } from "@/lib/queue";
import { getEnv, isWhatsAppConfigured } from "@/lib/env";

/**
 * GET /api/health
 * Quick check that Postgres, Redis and WhatsApp credentials are in place.
 */
export async function GET() {
  const env = getEnv();

  const [database, redis] = await Promise.all([
    prisma
      .$queryRaw`SELECT 1`
      .then(() => ({ ok: true as const }))
      .catch((err: Error) => ({ ok: false as const, error: err.message })),
    getRedisConnection()
      .ping()
      .then(() => ({ ok: true as const }))
      .catch((err: Error) => ({ ok: false as const, error: err.message })),
  ]);

  const whatsapp = {
    ok: isWhatsAppConfigured(env),
    mode: env.WHATSAPP_USE_TEMPLATE
      ? `template:${env.WHATSAPP_TEMPLATE_NAME ?? "(unset)"}`
      : "free-form text",
    templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE,
    appSecretConfigured: Boolean(env.WHATSAPP_APP_SECRET),
  };

  const healthy = database.ok && redis.ok;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      timezone: env.APP_TIMEZONE,
      checks: { database, redis, whatsapp },
    },
    { status: healthy ? 200 : 503 },
  );
}
