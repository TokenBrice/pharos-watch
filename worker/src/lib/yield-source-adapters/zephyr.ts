import { parseEpochSeconds } from "@shared/lib/epoch";
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

function getFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUnixSecondsHeader(res: Response, headerName: string): number | null {
  const raw = res.headers.get(headerName);
  if (!raw) return null;
  return parseEpochSeconds(Number(raw), {
    numericTextPolicy: "any",
    millisecondsThreshold: 10_000_000_000,
    millisecondsThresholdInclusive: false,
    floor: true,
    minExclusive: 0,
  });
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
        parseUnixSecondsHeader(result.response, "x-last-success-at") ??
        parseUnixSecondsHeader(result.response, "x-fetched-at") ??
        Math.floor(Date.now() / 1000),
      comparisonAnchorObservedAt: null,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    logWorkerEventArgs("handler", "warn", "[yield] Zephyr ZYS source failed:", error);
    return null;
  }
}
