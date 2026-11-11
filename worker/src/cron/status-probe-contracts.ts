import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { isFreshnessWarningHeader } from "@shared/lib/warning-headers";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { isRecord } from "@shared/lib/type-guards";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";

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

/**
 * ADR-42: reserve, live-reserve and redemption findings stay on `/status` and
 * cron metadata and never become operator Telegram conditions. Those planes
 * are identified by their endpoint naming rule — including admin probes such
 * as `/api/reserve-attempt-history` — so a newly added path cannot escape an
 * enumeration of today's few endpoints.
 */
const STATUS_LEVEL_ONLY_PATH_PREFIXES = [
  "/api/reserve-",
  "/api/stablecoin-reserves/",
  "/api/redemption-",
] as const;

export function isStatusLevelOnlyProbePath(path: string): boolean {
  const queryStart = path.indexOf("?");
  const pathname = queryStart === -1 ? path : path.slice(0, queryStart);
  return STATUS_LEVEL_ONLY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function evaluateStatusProbePayload(
  path: string,
  headers: Headers,
  payload: unknown,
): StatusProbePayloadVerdict {
  if (path.startsWith(STABLECOIN_RESERVES_PREFIX)) {
    const parsed = StablecoinReservesResponseSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: "invalid-reserve-payload" };
    const reserve = parsed.data;
    if (reserve.stablecoinId !== path.slice(STABLECOIN_RESERVES_PREFIX.length)) {
      return { ok: false, error: "reserve-identity-mismatch" };
    }
    const live = reserve.mode === "live" || reserve.mode === "live-stale";
    if ((reserve.reserves.length === 0) !== (reserve.mode === "unavailable")
      || reserve.estimated !== (reserve.mode === "template-fallback")
      || (live ? reserve.liveAt == null || reserve.sync?.stale !== (reserve.mode === "live-stale")
        : reserve.liveAt != null)) {
      return { ok: false, error: "reserve-mode-inconsistent" };
    }
    // Asset freshness and scoring admission are findings, not endpoint failures.
    return { ok: true };
  }
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

  return { ok: true };
}
