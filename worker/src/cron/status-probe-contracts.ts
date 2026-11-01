import { API_FRESHNESS_MAX_AGE_SEC, isFreshnessWarningHeader } from "@shared/lib/api-freshness";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type { StatusHealthValue } from "@shared/types/status/core";

/**
 * Payload contracts for probe paths whose HTTP status alone cannot prove the
 * published generation is usable. `/api/health` keeps its own parser because
 * its body is the status verdict itself.
 */
export interface StatusProbePayloadVerdict {
  ok: boolean;
  error?: string;
  semanticStatus?: StatusHealthValue;
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
    return { ok: false, error: "stale-freshness-header", semanticStatus: "stale" };
  }
  if (!isRecord(payload)) {
    return { ok: false, error: "invalid-probe-payload", semanticStatus: "stale" };
  }

  if (path === REDEMPTION_BACKSTOPS_PATH) {
    // The endpoint's consumer budget, not the reader-facing 8x warning band.
    const ageSeconds = Number(headers.get("X-Data-Age"));
    if (Number.isFinite(ageSeconds) && ageSeconds > API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops) {
      return { ok: false, error: `redemption-generation-stale:${Math.round(ageSeconds)}s`, semanticStatus: "stale" };
    }
    const coins = payload.coins;
    if (!isRecord(coins) || Object.keys(coins).length === 0) {
      return { ok: false, error: "redemption-coins-empty", semanticStatus: "stale" };
    }
    // Failed routes publish complete placeholder rows, so a non-empty map does
    // not prove resolution; only `resolved` rows carry admitted measurements.
    const unresolved = Object.values(coins).filter(
      (entry) => isRecord(entry) && entry.resolutionState === "failed",
    ).length;
    if (unresolved > 0) {
      return { ok: false, error: `redemption-unresolved-placeholders:${unresolved}`, semanticStatus: "degraded" };
    }
    return { ok: true, semanticStatus: "healthy" };
  }

  const mode = payload.mode;
  if (mode !== "live") {
    return {
      ok: false,
      error: `reserve-mode-${typeof mode === "string" ? mode : "unknown"}`,
      semanticStatus: mode === "live-stale" ? "stale" : "degraded",
    };
  }
  const sync = payload.sync;
  const syncStatus = isRecord(sync) && typeof sync.status === "string" ? sync.status : null;
  if (syncStatus === "degraded" || syncStatus === "error") {
    return { ok: false, error: `reserve-sync-${syncStatus}`, semanticStatus: "degraded" };
  }
  if (!Array.isArray(payload.reserves) || payload.reserves.length === 0) {
    return { ok: false, error: "reserve-slices-empty", semanticStatus: "stale" };
  }
  return { ok: true, semanticStatus: "healthy" };
}
