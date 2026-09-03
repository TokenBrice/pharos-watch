import { formatIsoDate } from "@shared/lib/format";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { throwIfAborted } from "../lib/abort";
import { getCache, setCache } from "../lib/db-cache";
import { cancelResponseBodyQuietly, readResponseTextWithinLimitWithSignal } from "../lib/response-body";
import { escapeHtml, type TelegramCreds } from "../lib/telegram";
import type { CronResult } from "../lib/cron-logger";
import {
  NON_BLOCKED_DIGEST_SQL_FILTER,
  NON_INTERNAL_DIGEST_SQL_FILTER,
  NON_WEEKLY_DIGEST_SQL_FILTER,
} from "../lib/digest-sql-filters";
import { classifyFreshness } from "../lib/status/freshness-oracle";
import { deliverOperatorAlert } from "./cron-sentinel-rules";

const DIGEST_WATCHDOG_STATE_KEY = "digest-publication-watchdog:state:v1";
const DIGEST_WATCHDOG_ALERT_KEY = "digest-publication-watchdog:alert:v1";
export const DIGEST_PUBLICATION_ALERT_COOLDOWN_SEC = 30 * 60;

const MAP_READY_AFTER_SEC = 7 * 3600 + 45 * 60;
const DAILY_DIGEST_DUE_AFTER_SEC = 8 * 3600 + 30 * 60;
const WEEKLY_DIGEST_DUE_AFTER_SEC = 8 * 3600 + 35 * 60;
const MAP_MANIFEST_MAX_BYTES = 16_384;
const MAP_MANIFEST_TIMEOUT_MS = 3_000;

function isDueAfter(dayStartSec: number, nowSec: number, dueAfterSec: number): boolean {
  return classifyFreshness(
    {
      job: "digest-publication-clock",
      lastSuccessAt: dayStartSec,
      lastRunAt: dayStartSec,
      expectedIntervalSec: dueAfterSec,
      lastStatus: "ok",
    },
    {
      // Digest cutoffs are due at the exact second (`elapsed >= dueAfter`),
      // while freshness age limits are inclusive. Unix clocks are integral,
      // so dueAfter - 1 preserves the existing boundary exactly.
      watchAt: { absoluteSec: dueAfterSec - 1 },
      staleAt: { absoluteSec: dueAfterSec - 1 },
    },
    nowSec,
  ).state === "stale";
}

/**
 * Single source for the condition set. The union is derived from it and every
 * persisted-state validator reads it, so adding a condition cannot silently
 * miss one of the checks.
 */
const DIGEST_PUBLICATION_CONDITIONS = [
  "daily-row",
  "daily-telegram",
  "daily-twitter",
  "weekly-row",
  "weekly-telegram",
  "weekly-twitter",
  "map-producer-lag",
] as const;

type DigestPublicationCondition = typeof DIGEST_PUBLICATION_CONDITIONS[number];

function isDigestPublicationCondition(value: unknown): value is DigestPublicationCondition {
  return typeof value === "string"
    && (DIGEST_PUBLICATION_CONDITIONS as readonly string[]).includes(value);
}

type ConditionState = "ok" | "stale";

interface DigestPublicationWatchdogState {
  date: string;
  statuses: Partial<Record<DigestPublicationCondition, ConditionState>>;
  alerted: DigestPublicationCondition[];
  recovered: DigestPublicationCondition[];
}

interface DigestPublicationObservation {
  condition: DigestPublicationCondition;
  state: ConditionState;
  detail: string;
  advisory: boolean;
}

interface MapManifestObservation {
  date: string | null;
  reason: string | null;
}

export interface DigestPublicationWatchdogOptions {
  /** Operator-only destination. Null suppresses Telegram while state advances. */
  operatorTelegramCreds?: TelegramCreds | null;
}

function parseState(value: string | null | undefined): DigestPublicationWatchdogState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DigestPublicationWatchdogState>;
    if (
      typeof parsed.date !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
      || !parsed.statuses
      || typeof parsed.statuses !== "object"
      || !Array.isArray(parsed.alerted)
    ) {
      return null;
    }
    const statuses: DigestPublicationWatchdogState["statuses"] = {};
    for (const [condition, state] of Object.entries(parsed.statuses)) {
      if (isDigestPublicationCondition(condition) && (state === "ok" || state === "stale")) {
        statuses[condition] = state;
      }
    }
    const alerted = parsed.alerted.filter(isDigestPublicationCondition);
    const recovered = (Array.isArray(parsed.recovered) ? parsed.recovered : [])
      .filter(isDigestPublicationCondition);
    return { date: parsed.date, statuses, alerted, recovered };
  } catch {
    return null;
  }
}

async function readFirst<T>(
  db: D1Database,
  sql: string,
  binds: readonly unknown[],
  signal?: AbortSignal,
): Promise<T | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () => db.prepare(sql).bind(...binds).first<T>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return row ?? null;
}

async function readMapManifestDate(
  signal?: AbortSignal,
): Promise<MapManifestObservation> {
  const timeoutSignal = AbortSignal.timeout(MAP_MANIFEST_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(`${SITE_ORIGIN}/safety-scores/map.json`, {
      headers: { Accept: "application/json" },
      signal: requestSignal,
    });
    if (!response.ok) {
      await cancelResponseBodyQuietly(response);
      return { date: null, reason: `manifest-http-${response.status}` };
    }
    const raw = await readResponseTextWithinLimitWithSignal(
      response,
      MAP_MANIFEST_MAX_BYTES,
      requestSignal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { date: null, reason: "manifest-invalid-json" };
    }
    const manifestDate = parsed && typeof parsed === "object"
      ? (parsed as { date?: unknown }).date
      : null;
    if (typeof manifestDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(manifestDate)) {
      return { date: null, reason: "manifest-invalid" };
    }
    return { date: manifestDate, reason: null };
  } catch (error) {
    throwIfAborted(signal);
    const reason = error instanceof Error && error.message
      ? error.message.slice(0, 80)
      : "read-failed";
    return { date: null, reason: `manifest-read-failed:${reason}` };
  }
}

function conditionLabel(condition: DigestPublicationCondition): string {
  switch (condition) {
    case "daily-row": return "daily digest row";
    case "daily-telegram": return "daily Telegram edition";
    case "daily-twitter": return "daily Twitter edition";
    case "weekly-row": return "weekly recap row";
    case "weekly-telegram": return "weekly Telegram edition";
    case "weekly-twitter": return "weekly Twitter edition";
    case "map-producer-lag": return "Safety Score map producer";
  }
}

function buildAlertText(
  date: string,
  stale: readonly DigestPublicationObservation[],
  recovered: readonly DigestPublicationObservation[],
): string {
  const sections: string[] = [];
  const stalePublication = stale.filter((observation) => !observation.advisory);
  const staleAdvisories = stale.filter((observation) => observation.advisory);
  if (stalePublication.length > 0) {
    sections.push(
      `<b>Late digest conditions</b>: ${stalePublication.map((observation) => `${escapeHtml(conditionLabel(observation.condition))} (${escapeHtml(observation.detail)})`).join(", ")}`,
    );
  }
  if (staleAdvisories.length > 0) {
    sections.push(
      `<b>Producer-lag notice</b>: ${staleAdvisories.map((observation) => `${escapeHtml(observation.detail)}`).join(", ")}. Digest publication remains unblocked.`,
    );
  }
  if (recovered.length > 0) {
    sections.push(
      `<b>Recovered conditions</b>: ${recovered.map((observation) => escapeHtml(conditionLabel(observation.condition))).join(", ")}`,
    );
  }
  return `<b>Digest publication watchdog</b>\n\nUTC ${escapeHtml(date)}\n${sections.join("\n")}`;
}

/**
 * Whether a Twitter digest ledger marker records an actual delivery. Marker
 * presence alone never proves a tweet: the ledger inserts `queued`, advances
 * to `sending`, and only then attempts the post. Both editions carry their own
 * marker key, so daily and weekly are asserted independently.
 */
async function readTwitterLedgerDelivered(
  db: D1Database,
  markerKey: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const marker = await getCache(db, markerKey, signal);
  if (!marker) return false;
  try {
    const parsed = JSON.parse(marker.value) as { state?: unknown; sentAt?: unknown };
    // Older same-day markers predate the durable ledger and are still
    // treated as duplicate-safe by the publisher.
    return parsed.state === "sent"
      || (parsed.state == null && typeof parsed.sentAt === "number");
  } catch {
    // A legacy plain marker is not JSON, but the ledger's pre-ledger contract
    // treated its presence as already delivered.
    return marker.value === "sent";
  }
}

async function readPublicationObservations(
  db: D1Database,
  date: string,
  dayStartSec: number,
  nowSec: number,
  options: {
    dailyDue: boolean;
    weeklyDue: boolean;
    mapDue: boolean;
  },
  signal?: AbortSignal,
): Promise<{ observations: DigestPublicationObservation[]; map: MapManifestObservation | null }> {
  const observations: DigestPublicationObservation[] = [];
  let map: MapManifestObservation | null = null;

  if (options.dailyDue) {
    const dailyRow = await readFirst<{ present: number }>(
      db,
      `SELECT 1 AS present
         FROM daily_digest
        WHERE generated_at >= ? AND generated_at <= ?
          AND (${NON_WEEKLY_DIGEST_SQL_FILTER})
          AND (${NON_INTERNAL_DIGEST_SQL_FILTER})
          AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
        LIMIT 1`,
      [dayStartSec, nowSec],
      signal,
    );
    const telegram = await readFirst<{ state: string }>(
      db,
      "SELECT state FROM telegram_digest_outbox WHERE edition_key = ?",
      [`daily:${date}`],
      signal,
    );
    const twitterSent = await readTwitterLedgerDelivered(db, `daily-digest:twitter-sent:${date}`, signal);
    observations.push(
      {
        condition: "daily-row",
        state: dailyRow ? "ok" : "stale",
        detail: dailyRow ? "present" : "no non-blocked row for today",
        advisory: false,
      },
      {
        condition: "daily-telegram",
        state: telegram?.state === "sent" ? "ok" : "stale",
        detail: telegram?.state === "sent" ? "sent" : `outbox ${telegram?.state ?? "missing"}`,
        advisory: false,
      },
      {
        condition: "daily-twitter",
        state: twitterSent ? "ok" : "stale",
        detail: twitterSent ? "sent" : "ledger not delivered",
        advisory: false,
      },
    );
  }

  if (options.weeklyDue) {
    const weeklyRow = await readFirst<{ present: number }>(
      db,
      `SELECT 1 AS present
         FROM daily_digest
        WHERE generated_at >= ? AND generated_at <= ?
          AND json_extract(digest_meta, '$.type') = 'weekly'
          AND (${NON_INTERNAL_DIGEST_SQL_FILTER})
          AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
        LIMIT 1`,
      [dayStartSec, nowSec],
      signal,
    );
    const weeklyTelegram = await readFirst<{ state: string }>(
      db,
      "SELECT state FROM telegram_digest_outbox WHERE edition_key = ?",
      [`weekly:${date}`],
      signal,
    );
    const weeklyTwitterSent = await readTwitterLedgerDelivered(
      db,
      `weekly-recap:twitter-sent:${date}`,
      signal,
    );
    observations.push(
      {
        condition: "weekly-row",
        state: weeklyRow ? "ok" : "stale",
        detail: weeklyRow ? "present" : "no non-blocked row for today",
        advisory: false,
      },
      {
        condition: "weekly-telegram",
        state: weeklyTelegram?.state === "sent" ? "ok" : "stale",
        detail: weeklyTelegram?.state === "sent" ? "sent" : `outbox ${weeklyTelegram?.state ?? "missing"}`,
        advisory: false,
      },
      {
        condition: "weekly-twitter",
        state: weeklyTwitterSent ? "ok" : "stale",
        detail: weeklyTwitterSent ? "sent" : "ledger not delivered",
        advisory: false,
      },
    );
  }

  if (options.mapDue) {
    map = await readMapManifestDate(signal);
    const mapCurrent = map.date === date;
    observations.push({
      condition: "map-producer-lag",
      state: mapCurrent ? "ok" : "stale",
      detail: mapCurrent
        ? "manifest is current"
        : `map manifest for ${date} is unavailable${map.reason ? ` (${map.reason})` : ` (published ${map.date ?? "no date"})`}`,
      advisory: true,
    });
  }

  return { observations, map };
}

export async function runDigestPublicationWatchdog(
  db: D1Database,
  nowSec: number,
  options: DigestPublicationWatchdogOptions = {},
  signal?: AbortSignal,
): Promise<CronResult> {
  throwIfAborted(signal);
  const date = formatIsoDate(nowSec);
  const dayStartSec = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  const utcDay = new Date(nowSec * 1000).getUTCDay();
  const dailyDue = isDueAfter(dayStartSec, nowSec, DAILY_DIGEST_DUE_AFTER_SEC);
  const weeklyDue = utcDay === 1 && isDueAfter(dayStartSec, nowSec, WEEKLY_DIGEST_DUE_AFTER_SEC);
  const mapDue = isDueAfter(dayStartSec, nowSec, MAP_READY_AFTER_SEC);
  const { observations, map } = await readPublicationObservations(
    db,
    date,
    dayStartSec,
    nowSec,
    { dailyDue, weeklyDue, mapDue },
    signal,
  );

  const stateCache = await getCache(db, DIGEST_WATCHDOG_STATE_KEY, signal);
  const alertCache = await getCache(db, DIGEST_WATCHDOG_ALERT_KEY, signal);
  const previous = parseState(stateCache?.value);
  const sameDay = previous?.date === date;
  const previousStatuses = sameDay ? previous?.statuses ?? {} : {};
  const alerted = new Set<DigestPublicationCondition>(sameDay ? previous?.alerted ?? [] : []);
  const recoveredToday = new Set<DigestPublicationCondition>(sameDay ? previous?.recovered ?? [] : []);
  const stale: DigestPublicationObservation[] = [];
  const recovered: DigestPublicationObservation[] = [];
  const nextStatuses: DigestPublicationWatchdogState["statuses"] = {};

  for (const observation of observations) {
    const prior = previousStatuses[observation.condition] ?? "ok";
    nextStatuses[observation.condition] = observation.state;
    if (observation.state === "stale") {
      if (prior !== "stale" && !alerted.has(observation.condition)) {
        stale.push(observation);
        alerted.add(observation.condition);
      }
    } else if (prior === "stale" && !recoveredToday.has(observation.condition)) {
      recovered.push(observation);
      recoveredToday.add(observation.condition);
    }
  }

  await setCache(
    db,
    DIGEST_WATCHDOG_STATE_KEY,
    JSON.stringify({
      date,
      statuses: nextStatuses,
      alerted: [...alerted],
      recovered: [...recoveredToday],
    } satisfies DigestPublicationWatchdogState),
    signal,
  );

  const transitions = {
    stale: stale.map((observation) => observation.condition),
    recovered: recovered.map((observation) => observation.condition),
    sent: false,
    cooldown: false,
  };
  if (stale.length > 0 || recovered.length > 0) {
    // The map check is deliberately advisory. It must not consume the shared
    // publication-alert cooldown, otherwise a 07:45 map notice could hide a
    // genuinely late daily edition at 08:30.
    const hasBlockingTransition = [...stale, ...recovered].some((observation) => !observation.advisory);
    const lastAlertAt = Number(alertCache?.value);
    const cooldown = hasBlockingTransition && Number.isFinite(lastAlertAt)
      && nowSec - lastAlertAt < DIGEST_PUBLICATION_ALERT_COOLDOWN_SEC;
    transitions.cooldown = cooldown;
    const creds = options.operatorTelegramCreds ?? null;
    if (!cooldown && creds) {
      const delivery = await deliverOperatorAlert(
        creds,
        buildAlertText(date, stale, recovered),
        signal,
      );
      if (delivery.ok && hasBlockingTransition) {
        transitions.sent = true;
        await setCache(db, DIGEST_WATCHDOG_ALERT_KEY, String(nowSec), signal);
      } else if (delivery.ok) {
        transitions.sent = true;
      }
    }
  }

  const blockingStale = observations.filter((observation) => (
    !observation.advisory && observation.state === "stale"
  ));
  return {
    status: blockingStale.length > 0 ? "degraded" : "ok",
    itemCount: blockingStale.length,
    metadata: JSON.stringify({
      date,
      cutoffs: { mapDue, dailyDue, weeklyDue },
      healthy: blockingStale.length === 0,
      conditions: Object.fromEntries(observations.map((observation) => [
        observation.condition,
        { state: observation.state, detail: observation.detail, advisory: observation.advisory },
      ])),
      map,
      alertTransitions: transitions,
    }),
  };
}
