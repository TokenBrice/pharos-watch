import { parseRetryAfterSeconds } from "@shared/lib/retry-after";
import { isRecord } from "@shared/lib/type-guards";
import { prepareCacheUpsert } from "./db-cache";

/**
 * Single D1 cache authority (R5) for Morpho Read API HTTP 429 cooldowns shared
 * across both the yield supplemental lane and the reserve-adapter lane.
 */
export const MORPHO_RATE_LIMIT_CACHE_KEY = "yield:supplemental-sources:v1:morpho-backoff";
export const MORPHO_RATE_LIMIT_BACKOFF_REASON = "morpho-rate-limited-backoff";
export const MORPHO_RATE_LIMIT_DEFAULT_BACKOFF_SEC = 600;
export const MORPHO_RATE_LIMIT_MAX_BACKOFF_SEC = 7 * 86_400;
const MORPHO_RATE_LIMIT_MAX_FUTURE_SKEW_SEC = 60;

export type MorphoRateLimitBackoffSource = "retry-after" | "default";

export interface MorphoRateLimitBackoff {
  backoffSec: number;
  source: MorphoRateLimitBackoffSource;
}

export interface PersistedMorphoRateLimitBackoff {
  backoffUntilSec: number;
  reason: typeof MORPHO_RATE_LIMIT_BACKOFF_REASON;
  source: MorphoRateLimitBackoffSource;
  recordedAtSec: number;
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

export function buildMorphoRateLimitBackoffPayload(
  backoff: MorphoRateLimitBackoff,
  recordedAtSec: number,
): string {
  return JSON.stringify({
    backoffUntilSec: recordedAtSec + backoff.backoffSec,
    reason: MORPHO_RATE_LIMIT_BACKOFF_REASON,
    source: backoff.source,
    recordedAtSec,
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
    return {
      backoffUntilSec,
      reason: MORPHO_RATE_LIMIT_BACKOFF_REASON,
      source,
      recordedAtSec,
    };
  } catch {
    return null;
  }
}

export async function persistMorphoRateLimitBackoff(
  db: D1Database,
  backoff: MorphoRateLimitBackoff,
  recordedAtSec: number,
): Promise<void> {
  await prepareCacheUpsert(
    db,
    {
      key: MORPHO_RATE_LIMIT_CACHE_KEY,
      value: buildMorphoRateLimitBackoffPayload(backoff, recordedAtSec),
      updatedAt: recordedAtSec,
    },
    "if-newer",
  ).run();
}
