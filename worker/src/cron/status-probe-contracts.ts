import { API_FRESHNESS_MAX_AGE_SEC, isFreshnessWarningHeader } from "@shared/lib/api-freshness";
import { API_PATHS } from "@shared/lib/api-endpoints";

/**
 * Payload contracts for probe paths whose HTTP status alone cannot prove the
 * published generation is usable. `/api/health` keeps its own parser because
 * its body is the status verdict itself, so these contracts only pass or fail
 * their probe and enter the per-path two-sweep floor like any other failure.
 */
export interface StatusProbePayloadVerdict {
  ok: boolean;
  error?: string;
}

const REDEMPTION_BACKSTOPS_PATH = API_PATHS.redemptionBackstops();
const STABLECOIN_RESERVES_PREFIX = API_PATHS.stablecoinReserves("");

export function hasStatusProbePayloadContract(path: string): boolean {
  return path === REDEMPTION_BACKSTOPS_PATH || path.startsWith(STABLECOIN_RESERVES_PREFIX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function evaluateStatusProbePayload(
  path: string,
  headers: Headers,
  payload: unknown,
): StatusProbePayloadVerdict {
  // The producer's own freshness verdict outranks any structural reading.
  const warningHeader = headers.get("Warning");
  if (warningHeader && isFreshnessWarningHeader(warningHeader)) {
    return { ok: false, error: "stale-freshness-header" };
  }
  // `addFreshnessHeaders` marks a future-dated generation `199 - "Response
  // timestamp is ...s in the future"` with `no-store` while clamping
  // `X-Data-Age` to 0, so the code is the only surviving evidence that the
  // producer judged its own generation clock unusable.
  if (warningHeader && /(?:^|,\s*)199\b/.test(warningHeader)) {
    return { ok: false, error: "generation-timestamp-in-future" };
  }
  if (!isRecord(payload)) {
    return { ok: false, error: "invalid-probe-payload" };
  }

  if (path === REDEMPTION_BACKSTOPS_PATH) {
    // The endpoint's consumer budget, not the reader-facing 8x warning band.
    const ageSeconds = Number(headers.get("X-Data-Age"));
    if (Number.isFinite(ageSeconds) && ageSeconds > API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops) {
      return { ok: false, error: `redemption-generation-stale:${Math.round(ageSeconds)}s` };
    }
    const coins = payload.coins;
    if (!isRecord(coins) || Object.keys(coins).length === 0) {
      return { ok: false, error: "redemption-coins-empty" };
    }
    // Failed routes publish complete placeholder rows, so a non-empty map does
    // not prove resolution; only `resolved` rows carry admitted measurements.
    const unresolved = Object.values(coins).filter(
      (entry) => isRecord(entry) && entry.resolutionState === "failed",
    ).length;
    if (unresolved > 0) {
      return { ok: false, error: `redemption-unresolved-placeholders:${unresolved}` };
    }
    return { ok: true };
  }

  const mode = payload.mode;
  if (mode !== "live") {
    return { ok: false, error: `reserve-mode-${typeof mode === "string" ? mode : "unknown"}` };
  }
  const sync = payload.sync;
  const syncStatus = isRecord(sync) && typeof sync.status === "string" ? sync.status : null;
  if (syncStatus === "degraded" || syncStatus === "error") {
    return { ok: false, error: `reserve-sync-${syncStatus}` };
  }
  if (!Array.isArray(payload.reserves) || payload.reserves.length === 0) {
    return { ok: false, error: "reserve-slices-empty" };
  }
  return { ok: true };
}
