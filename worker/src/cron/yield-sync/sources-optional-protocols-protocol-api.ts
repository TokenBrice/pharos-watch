import { DAY_SECONDS } from "@shared/lib/time-constants";
import { type ChainRpcConfig, getChainRpc } from "../../lib/chain-registry";
import { finiteDecimalNumberFromBigInt } from "../../lib/bigint";
import { USER_AGENT } from "../../lib/constants";
import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS, getFiniteNumber } from "./optional-source-runtime";
import {
  ETHERFUSE_CETES_SOURCE_KEY,
  ETHERFUSE_CETES_SOURCE_LABEL,
  ETHERFUSE_CETES_SOURCE_TYPE,
  fetchEtherfuseCetesIssuance,
} from "./etherfuse-cetes";
import type { ResolvedYield } from "./types";

interface HashnoteReport {
  roundId: string;
  price: string;
  timestamp: string;
}

interface BimaEarnPool {
  id?: string;
  amountTVL?: number;
  unboostedAPR?: number;
  boostedAPR?: number;
  token?: {
    title?: string;
    label?: string;
  };
}

interface ZephyrReturnWindow {
  effectiveApy?: number;
}

interface ZephyrHistoricalReturns {
  oneDay?: ZephyrReturnWindow;
}

const BIMA_SUSBD_SOURCE_KEY = "protocol-api:bima-susbd";
const BIMA_SUSBD_SOURCE_LABEL = "BIMA savings (sUSBD)";
const BIMA_SUSBD_SOURCE_TYPE = "lending-vault";
const BIMA_EARN_POOLS_URL =
  "https://bima.money/api/earn/pools?network=Ethereum&user=0x0000000000000000000000000000000000000000";
const BIMA_MIN_TVL_USD = 100_000;
const BIMA_MIN_APY_PERCENT = 0.01;
const BIMA_MAX_APY_PERCENT = 100;
const HASHNOTE_USYC_SOURCE_KEY = "protocol-api:hashnote-usyc";
const HASHNOTE_USYC_SOURCE_LABEL = "Hashnote USYC";
const HASHNOTE_USYC_SOURCE_TYPE = "nav-appreciation";
const HASHNOTE_PRICE_REPORTS_URL = "https://usyc.hashnote.com/api/price-reports";
const HASHNOTE_TARGET_LOOKBACK_SEC = 7 * DAY_SECONDS;
const HASHNOTE_MIN_LOOKBACK_SEC = 5 * DAY_SECONDS;
const HASHNOTE_MAX_FRESHNESS_SEC = 3 * DAY_SECONDS;
const ONDO_USDY_SOURCE_KEY = "protocol-api:ondo-usdy-oracle";
const ONDO_USDY_SOURCE_LABEL = "Ondo USDY Oracle";
const ONDO_USDY_SOURCE_TYPE = "nav-appreciation";
const ONDO_USDY_ORACLE = "0xa0219aa5b31e65bc920b5b6dfb8edf0988121de0";
const ONDO_GET_PRICE_SELECTOR = "0x98d5fdca";
const ZEPHYR_ZYS_SOURCE_KEY = "protocol-api:zys-zephyr-protocol";
const ZEPHYR_ZYS_SOURCE_LABEL = "Zephyr Scanner ZYS returns";
const ZEPHYR_ZYS_SOURCE_TYPE = "nav-appreciation";
const ZEPHYR_HISTORICAL_RETURNS_URL = "https://zephyrprotocol.com/api/v1/historicalreturns";
const ZEPHYR_MIN_APY_PERCENT = 0;
const ZEPHYR_MAX_APY_PERCENT = 500;

function parseUnixSecondsHeader(res: Response, headerName: string): number | null {
  const raw = res.headers.get(headerName);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

export async function fetchBimaSusbdSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  try {
    const result = await fetchJsonWithRetry<{ success?: boolean; data?: unknown }>(
      BIMA_EARN_POOLS_URL,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal,
      },
      0,
      { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
    );
    if (!result?.response.ok) return null;

    const body = result.body;
    if (!body.success || !Array.isArray(body.data) || body.data.length === 0) return null;

    const pool = (body.data as BimaEarnPool[]).find((entry) => {
      const title = entry.token?.title?.toUpperCase();
      const label = entry.token?.label?.toUpperCase();
      return title === "USBD" || label === "USBD";
    });
    if (!pool) return null;

    const unboostedApr = getFiniteNumber(pool.unboostedAPR);
    if (unboostedApr == null || unboostedApr < BIMA_MIN_APY_PERCENT || unboostedApr > BIMA_MAX_APY_PERCENT) {
      return null;
    }

    const sourceTvlUsd = getFiniteNumber(pool.amountTVL);
    const qualifiedTvlUsd = sourceTvlUsd != null && sourceTvlUsd >= BIMA_MIN_TVL_USD
      ? sourceTvlUsd
      : null;
    if (qualifiedTvlUsd == null) return null;

    return {
      currentApy: unboostedApr,
      apyBase: unboostedApr,
      apyReward: null,
      sourcePool: typeof pool.id === "string" ? pool.id : null,
      sourceTvlUsd: qualifiedTvlUsd,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey: BIMA_SUSBD_SOURCE_KEY,
      yieldSource: BIMA_SUSBD_SOURCE_LABEL,
      yieldType: BIMA_SUSBD_SOURCE_TYPE,
      sourceObservedAt: Math.floor(Date.now() / 1000),
      comparisonAnchorObservedAt: null,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    console.warn("[yield] BIMA sUSBD source failed:", error);
    return null;
  }
}

export async function fetchEtherfuseCetesSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  const issuance = await fetchEtherfuseCetesIssuance({
    signal,
    timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
    retries: 0,
  });
  if (!issuance) return null;

  return {
    currentApy: issuance.apyPercent,
    apyBase: issuance.apyPercent,
    apyReward: null,
    sourcePool: issuance.issuanceAddress,
    sourceTvlUsd: null,
    dataSource: "protocol-api",
    exchangeRate: issuance.currentTokenAmount,
    sourceKey: ETHERFUSE_CETES_SOURCE_KEY,
    yieldSource: ETHERFUSE_CETES_SOURCE_LABEL,
    yieldType: ETHERFUSE_CETES_SOURCE_TYPE,
    sourceObservedAt: issuance.observedAtSec,
    comparisonAnchorObservedAt: null,
  };
}

export async function fetchHashnoteUsycSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  try {
    const result = await fetchJsonWithRetry<{ entity?: string; data?: HashnoteReport[] }>(
      HASHNOTE_PRICE_REPORTS_URL,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal,
      },
      0,
      { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
    );
    if (!result?.response.ok) return null;

    const body = result.body;
    const reports = body.data;
    if (!Array.isArray(reports) || reports.length < 2) return null;

    const sortedReports = [...reports]
      .map((report) => ({
        ...report,
        parsedTimestamp: parseInt(report.timestamp, 10),
      }))
      .filter((report) => Number.isFinite(report.parsedTimestamp))
      .sort((a, b) => b.parsedTimestamp - a.parsedTimestamp);
    if (sortedReports.length < 2) return null;

    const latest = sortedReports[0];
    const latestPrice = parseFloat(latest.price);
    const latestTimeSec = latest.parsedTimestamp;
    if (!Number.isFinite(latestPrice) || latestPrice <= 0) return null;
    if (!Number.isFinite(latestTimeSec)) return null;
    if (Math.floor(Date.now() / 1000) - latestTimeSec > HASHNOTE_MAX_FRESHNESS_SEC) return null;

    const targetAnchorSec = latestTimeSec - HASHNOTE_TARGET_LOOKBACK_SEC;
    let anchor = sortedReports[sortedReports.length - 1];
    for (const report of sortedReports) {
      if (report.parsedTimestamp <= targetAnchorSec) {
        anchor = report;
        break;
      }
    }
    const anchorPrice = parseFloat(anchor.price);
    const anchorTimeSec = anchor.parsedTimestamp;
    if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) return null;

    const lookbackSec = latestTimeSec - anchorTimeSec;
    if (lookbackSec < HASHNOTE_MIN_LOOKBACK_SEC) return null;
    const daysDelta = lookbackSec / DAY_SECONDS;

    const apy = (Math.pow(latestPrice / anchorPrice, 365.25 / daysDelta) - 1) * 100;
    if (!Number.isFinite(apy) || apy < 0) return null;

    return {
      currentApy: apy, apyBase: apy, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: null, sourceKey: HASHNOTE_USYC_SOURCE_KEY,
      yieldSource: HASHNOTE_USYC_SOURCE_LABEL, yieldType: HASHNOTE_USYC_SOURCE_TYPE,
      sourceObservedAt: latestTimeSec,
      comparisonAnchorObservedAt: anchorTimeSec,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] Hashnote USYC source failed:", error);
    return null;
  }
}

export async function fetchOndoUsdyOracleSource(
  prevExchangeRate: number | null,
  daysDelta: number,
  comparisonAnchorObservedAt: number | null,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<ResolvedYield | null> {
  try {
    const rpc = chainRpcs ? getChainRpc(chainRpcs, "ethereum") : undefined;
    const extraRpcUrls = rpc?.fallbackRpcUrl ? [rpc.fallbackRpcUrl] : [];
    const currentPrice = await fetchEvmUint256AtBlock(
      "ethereum", ONDO_USDY_ORACLE, ONDO_GET_PRICE_SELECTOR, "latest",
      { extraRpcUrls, signal },
    );
    if (!currentPrice || currentPrice === 0n) return null;

    const currentPriceFloat = finiteDecimalNumberFromBigInt(currentPrice, 18);
    if (currentPriceFloat == null || !Number.isFinite(currentPriceFloat) || currentPriceFloat <= 0) return null;

    if (prevExchangeRate == null || prevExchangeRate === 0 || daysDelta < 1) {
      return {
        currentApy: 0, apyBase: null, apyReward: null,
        sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
        exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
        yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
        sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
      };
    }

    if (!Number.isFinite(prevExchangeRate) || prevExchangeRate <= 0) return null;
    const apy = (Math.pow(currentPriceFloat / prevExchangeRate, 365.25 / daysDelta) - 1) * 100;
    if (!Number.isFinite(apy) || apy < 0) return null;

    return {
      currentApy: apy, apyBase: apy, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
      yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
      sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt,
    };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    console.warn("[yield] Ondo USDY oracle source failed:", error);
    return null;
  }
}

export async function fetchZephyrZysSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
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
    console.warn("[yield] Zephyr ZYS source failed:", error);
    return null;
  }
}
