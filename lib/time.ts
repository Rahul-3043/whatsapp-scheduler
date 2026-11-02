import { DateTime } from "luxon";
import { getEnv } from "./env";

/**
 * All timestamps are stored in PostgreSQL as UTC instants. The app timezone
 * (Asia/Kolkata by default) is applied only at the edges:
 *
 *   form (local date + time)  ->  UTC instant  ->  database
 *   database (UTC instant)    ->  local string ->  UI / confirmation
 *
 * This keeps comparisons and queue delays correct regardless of the server's
 * own timezone setting.
 */

export function appTimezone(): string {
  return getEnv().APP_TIMEZONE;
}

export interface LocalDateTimeParts {
  /** ISO calendar date, e.g. "2026-11-05" */
  date: string;
  /** 24-hour clock, e.g. "09:30" */
  time: string;
}

/**
 * Combine a wall-clock date + time in the app timezone into an exact UTC
 * instant.
 *
 * Returns a Result rather than throwing so route handlers can turn timezone
 * problems (invalid date, DST gap) into clean 400 responses.
 */
export function localToUtc(
  parts: LocalDateTimeParts,
  zone: string = appTimezone(),
): { ok: true; utc: Date } | { ok: false; error: string } {
  const dt = DateTime.fromISO(`${parts.date}T${parts.time}`, { zone });

  if (!dt.isValid) {
    return {
      ok: false,
      error: `Invalid date/time "${parts.date} ${parts.time}" for timezone ${zone}: ${
        dt.invalidExplanation ?? dt.invalidReason
      }`,
    };
  }

  const utc = dt.toUTC();
  if (!utc.isValid) {
    return { ok: false, error: `Could not convert to UTC: ${utc.invalidExplanation}` };
  }

  return { ok: true, utc: utc.toJSDate() };
}

/** Human-readable local representation, e.g. "Thu, 05 Nov 2026 at 09:30 AM (Asia/Kolkata)". */
export function formatInAppTimezone(
  date: Date,
  zone: string = appTimezone(),
): string {
  return DateTime.fromJSDate(date, { zone: "utc" })
    .setZone(zone)
    .toFormat("ccc, dd LLL yyyy 'at' hh:mm a");
}

/** Split a UTC instant back into the app-timezone date/time parts. */
export function utcToLocalParts(
  date: Date,
  zone: string = appTimezone(),
): LocalDateTimeParts {
  const dt = DateTime.fromJSDate(date, { zone: "utc" }).setZone(zone);
  return { date: dt.toISODate() ?? "", time: dt.toFormat("HH:mm") };
}

/** Milliseconds from now until `target`; never negative. */
export function delayUntil(target: Date, now: Date = new Date()): number {
  return Math.max(0, target.getTime() - now.getTime());
}

export { DateTime };
