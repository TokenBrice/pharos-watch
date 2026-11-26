import { parseRetryAfterSeconds } from "@shared/lib/retry-after";
import { isRecord } from "@shared/lib/type-guards";

/**
 * Single D1 cache authority (R5) for Morpho Read API HTTP 429 cooldowns shared
 * across both the yield supplemental lane and the reserve-adapter lane.
 */
export const MORPHO_RATE_LIMIT_CACHE_KEY = "yield:supplemental-sources:v1:morpho-backoff";
export const MORPHO_RATE_LIMIT_BACKOFF_REASON = "morpho-rate-limited-backoff";
const MORPHO_RATE_LIMIT_DEFAULT_BACKOFF_SEC = 600;
const MORPHO_RATE_LIMIT_MAX_BACKOFF_SEC = 7 * 86_400;
const MORPHO_RATE_LIMIT_MAX_FUTURE_SKEW_SEC = 60;

type MorphoRateLimitBackoffSource = "retry-after" | "default";
type MorphoRateLimitOrigin = "yield-supplemental" | "reserve-adapter";

export interface MorphoRateLimitBackoff {
  backoffSec: number;
  source: MorphoRateLimitBackoffSource;
}

interface PersistedMorphoRateLimitBackoff {
  backoffUntilSec: number;
  reason: typeof MORPHO_RATE_LIMIT_BACKOFF_REASON;
  source: MorphoRateLimitBackoffSource;
  recordedAtSec: number;
  origin?: MorphoRateLimitOrigin;
}

export function resolveMorphoRateLimitBackoff(response: Response, nowMs: number): MorphoRateLimitBackoff {
  const retryAfterSec = parseRetryAfterSeconds(response.headers.get("Retry-After"), { nowMs });
  if (retryAfterSec != null && retryAfterSec > 0) {
    return {
      backoffSec: Math.min(retryAfterSec, MORPHO_RATE_LIMIT_MAX_BACKOFF_SEC),
      source: "retry-after",
    };
  }
  return {
    backoffSec: MORPHO_RATE_LIMIT_DEFAULT_BACKOFF_SEC,
    source: "default",
  };
}

function buildMorphoRateLimitBackoffPayload(
  backoff: MorphoRateLimitBackoff,
  recordedAtSec: number,
  origin: MorphoRateLimitOrigin,
): string {
  return JSON.stringify({
    backoffUntilSec: recordedAtSec + backoff.backoffSec,
    reason: MORPHO_RATE_LIMIT_BACKOFF_REASON,
    source: backoff.source,
    recordedAtSec,
    origin,
  } satisfies PersistedMorphoRateLimitBackoff);
}

export function parseMorphoRateLimitBackoff(
  raw: string | null | undefined,
  nowSec: number,
): PersistedMorphoRateLimitBackoff | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const { backoffUntilSec, recordedAtSec } = parsed;
    if (
      typeof backoffUntilSec !== "number"
      || !Number.isInteger(backoffUntilSec)
      || backoffUntilSec <= nowSec
      || typeof recordedAtSec !== "number"
      || !Number.isSafeInteger(recordedAtSec)
      || recordedAtSec < 0
      || recordedAtSec > nowSec + MORPHO_RATE_LIMIT_MAX_FUTURE_SKEW_SEC
      || backoffUntilSec <= recordedAtSec
      || backoffUntilSec - recordedAtSec > MORPHO_RATE_LIMIT_MAX_BACKOFF_SEC
    ) {
      return null;
    }
    const source: MorphoRateLimitBackoffSource = parsed.source === "retry-after" ? "retry-after" : "default";
    const origin: MorphoRateLimitOrigin | undefined =
      parsed.origin === "yield-supplemental" || parsed.origin === "reserve-adapter"
        ? parsed.origin
        : undefined;
    return {
      backoffUntilSec,
      reason: MORPHO_RATE_LIMIT_BACKOFF_REASON,
      source,
      recordedAtSec,
      ...(origin ? { origin } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Atomically persist the Morpho 429 cooldown while preserving whichever valid
 * row extends `backoffUntilSec` further into the future (replacing expired or
 * malformed rows so overlapping or delayed reserve/yield writes never shorten
 * an active Retry-After window).
 */
export async function persistMorphoRateLimitBackoff(
  db: D1Database,
  backoff: MorphoRateLimitBackoff,
  recordedAtSec: number,
  origin: MorphoRateLimitOrigin,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<PersistedMorphoRateLimitBackoff> {
  const payload = buildMorphoRateLimitBackoffPayload(backoff, recordedAtSec, origin);
  const checkNowSec = Math.max(recordedAtSec, nowSec);
  const result = await db
    .prepare(
      "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) "
      + "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at "
      + "WHERE CASE "
      + "WHEN json_valid(cache.value) "
      + "AND json_type(cache.value, '$.backoffUntilSec') = 'integer' "
      + "AND json_type(cache.value, '$.recordedAtSec') = 'integer' "
      + "AND CAST(json_extract(cache.value, '$.recordedAtSec') AS INTEGER) >= 0 "
      + "AND CAST(json_extract(cache.value, '$.recordedAtSec') AS INTEGER) <= ? + 60 "
      + "AND CAST(json_extract(cache.value, '$.backoffUntilSec') AS INTEGER) > CAST(json_extract(cache.value, '$.recordedAtSec') AS INTEGER) "
      + "AND CAST(json_extract(cache.value, '$.backoffUntilSec') AS INTEGER) - CAST(json_extract(cache.value, '$.recordedAtSec') AS INTEGER) <= 604800 "
      + "THEN CAST(json_extract(cache.value, '$.backoffUntilSec') AS INTEGER) "
      + "ELSE 0 END < CAST(json_extract(excluded.value, '$.backoffUntilSec') AS INTEGER)",
    )
    .bind(MORPHO_RATE_LIMIT_CACHE_KEY, payload, recordedAtSec, checkNowSec)
    .run();
  const attempted: PersistedMorphoRateLimitBackoff = {
    backoffUntilSec: recordedAtSec + backoff.backoffSec,
    reason: MORPHO_RATE_LIMIT_BACKOFF_REASON,
    source: backoff.source,
    recordedAtSec,
    origin,
  };
  if ((result.meta?.changes ?? 1) === 0) {
    const existing = await db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .bind(MORPHO_RATE_LIMIT_CACHE_KEY)
      .first<{ value: string }>();
    const retained = parseMorphoRateLimitBackoff(existing?.value, checkNowSec);
    if (retained) return retained;
  }
  return attempted;
}
