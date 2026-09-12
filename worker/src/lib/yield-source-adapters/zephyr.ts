import { fetchJsonWithRetry } from "../fetch-retry";
import { USER_AGENT } from "../constants";
import { logWorkerEventArgs } from "../structured-log";

interface ZephyrReturnWindow {
  effectiveApy?: number;
}

interface ZephyrHistoricalReturns {
  oneDay?: ZephyrReturnWindow;
}

interface ZephyrYieldSourceResult {
  currentApy: number;
  apyBase: number;
  apyReward: null;
  sourcePool: null;
  sourceTvlUsd: null;
  dataSource: "protocol-api";
  exchangeRate: null;
  sourceKey: string;
  yieldSource: string;
  yieldType: "nav-appreciation";
  sourceObservedAt: number;
  comparisonAnchorObservedAt: null;
}

const ZEPHYR_ZYS_SOURCE_KEY = "protocol-api:zys-zephyr-protocol";
const ZEPHYR_ZYS_SOURCE_LABEL = "Zephyr Scanner ZYS returns";
const ZEPHYR_ZYS_SOURCE_TYPE = "nav-appreciation" as const;
const ZEPHYR_HISTORICAL_RETURNS_URL = "https://zephyrprotocol.com/api/v1/historicalreturns";
const ZEPHYR_MIN_APY_PERCENT = 0;
const ZEPHYR_MAX_APY_PERCENT = 500;
const OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS = 8_000;
/**
 * B17 — the adapter cannot separate fetch time from observation time: Zephyr
 * self-reports its own clock in `x-last-success-at`/`x-fetched-at` (measured
 * 2026-09-12: two calls three seconds apart returned those headers at the request
 * clock, with `x-stale: 1` on one of them). A per-call timestamp therefore writes a
 * fresh phantom `yield_history` row on every read, and because the published
 * `apy30d` is an unweighted mean over exactly those rows each duplicate moves the
 * public average. Floor the upstream success time to one stable hourly bucket so
 * repeated reads of the same upstream window collapse into one row on the
 * `(stablecoin_id, source_key, recorded_at)` primary key; the backfill route is
 * `INSERT OR IGNORE`, so the second write is a no-op instead of a new observation.
 */
const ZEPHYR_OBSERVATION_BUCKET_SEC = 3600;

function getFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUnixSecondsHeader(res: Response, headerName: string): number | null {
  const raw = res.headers.get(headerName);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

/** `x-stale` is upstream's own statement that the payload is not a current read. */
function isStaleResponse(res: Response): boolean {
  const raw = res.headers.get("x-stale")?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export async function fetchZephyrZysSource(signal?: AbortSignal): Promise<ZephyrYieldSourceResult | null> {
  try {
    const result = await fetchJsonWithRetry<ZephyrHistoricalReturns>(
      ZEPHYR_HISTORICAL_RETURNS_URL,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal,
      },
      0,
      { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
    );
    if (!result?.response.ok) return null;

    if (isStaleResponse(result.response)) {
      logWorkerEventArgs("handler", "warn",
        "[yield] Zephyr ZYS source reported x-stale; skipping a stale observation rather than dating it now",
      );
      return null;
    }

    const upstreamSuccessSec =
      parseUnixSecondsHeader(result.response, "x-last-success-at")
      ?? parseUnixSecondsHeader(result.response, "x-fetched-at");
    if (upstreamSuccessSec == null) {
      logWorkerEventArgs("handler", "warn",
        "[yield] Zephyr ZYS source returned no observation timestamp header; refusing to date it from the fetch clock",
      );
      return null;
    }

    const body = result.body;
    const oneDayApy = getFiniteNumber(body.oneDay?.effectiveApy);
    if (
      oneDayApy == null ||
      oneDayApy < ZEPHYR_MIN_APY_PERCENT ||
      oneDayApy > ZEPHYR_MAX_APY_PERCENT
    ) {
      return null;
    }

    return {
      currentApy: oneDayApy,
      apyBase: oneDayApy,
      apyReward: null,
      sourcePool: null,
      sourceTvlUsd: null,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey: ZEPHYR_ZYS_SOURCE_KEY,
      yieldSource: ZEPHYR_ZYS_SOURCE_LABEL,
      yieldType: ZEPHYR_ZYS_SOURCE_TYPE,
      sourceObservedAt:
        Math.floor(upstreamSuccessSec / ZEPHYR_OBSERVATION_BUCKET_SEC) * ZEPHYR_OBSERVATION_BUCKET_SEC,
      comparisonAnchorObservedAt: null,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    logWorkerEventArgs("handler", "warn", "[yield] Zephyr ZYS source failed:", error);
    return null;
  }
}
