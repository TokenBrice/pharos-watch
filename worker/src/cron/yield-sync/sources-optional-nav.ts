import { DAY_SECONDS } from "@shared/lib/time-constants";
import { OPTIONAL_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
import { finiteDecimalNumberFromBigInt } from "../../lib/bigint";
import { type ChainRpcConfig, getChainRpc, registryRpcUrls } from "../../lib/chain-registry";
import { parseChainlinkLatestRoundData } from "../../lib/pricing/chainlink-round-data";
import { USER_AGENT } from "../../lib/constants";
import { fetchEvmCallHexAtBlock, fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "../../lib/evm-selectors";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { computeApyFromRate, isDeterministicApyWithinSanityBounds } from "./yield-helpers";
import { getFiniteNumber, OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS } from "./sources-rpc";
import type { ResolvedYield, ResolvedYieldCandidate } from "./types";

function annualizeNavReturn(rateNow: number, ratePrev: number, days: number) {
  const apy = computeApyFromRate(rateNow, ratePrev, days);
  // Preserve the admitted providers' -100% result when positive NAV division underflows.
  return typeof apy !== "number" && Number.isFinite(days) && days > 0 && rateNow / ratePrev === 0
    ? -100 : apy;
}

interface HashnoteReport {
  roundId: string;
  price: string;
  timestamp: string;
}

interface RePriceObservation {
  apy?: number;
  date?: string;
  price?: number;
}

interface RePriceResponse {
  success?: boolean;
  data?: {
    reUSD?: RePriceObservation[];
  };
}

const HASHNOTE_PRICE_REPORTS_URL = "https://usyc.hashnote.com/api/price-reports";
const HASHNOTE_TARGET_LOOKBACK_SEC = 7 * DAY_SECONDS;
const HASHNOTE_MIN_LOOKBACK_SEC = 5 * DAY_SECONDS;
const HASHNOTE_MAX_FRESHNESS_SEC = 3 * DAY_SECONDS;
const HASHNOTE_MAX_FUTURE_SKEW_SEC = 5 * 60;
const ONDO_USDY_ORACLE = "0xa0219aa5b31e65bc920b5b6dfb8edf0988121de0";
const ONDO_GET_PRICE_SELECTOR = "0x98d5fdca";
const RE_REUSD_PRICE_URL = "https://api.re.xyz/price";
const RE_REUSD_CONTRACT = "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72";
const RE_REUSD_MAX_FRESHNESS_SEC = 3 * DAY_SECONDS;
const RE_REUSD_MIN_APY_PERCENT = -100;
const RE_REUSD_MAX_APY_PERCENT = 500;

export async function fetchHashnoteUsycSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
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

  const nowSec = Math.floor(Date.now() / 1000);
  const sortedReports = [...reports]
    .map((report) => ({
      ...report,
      parsedTimestamp: Number(report.timestamp),
    }))
    .filter((report) => Number.isFinite(report.parsedTimestamp)
      && report.parsedTimestamp > 0
      && report.parsedTimestamp <= nowSec + HASHNOTE_MAX_FUTURE_SKEW_SEC)
    .sort((a, b) => b.parsedTimestamp - a.parsedTimestamp);
  if (sortedReports.length < 2) return null;

  const latest = sortedReports[0];
  const latestPrice = parseFloat(latest.price);
  const latestTimeSec = latest.parsedTimestamp;
  if (!Number.isFinite(latestPrice) || latestPrice <= 0) return null;
  if (!Number.isFinite(latestTimeSec)) return null;
  if (nowSec - latestTimeSec > HASHNOTE_MAX_FRESHNESS_SEC) return null;

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

  const apy = annualizeNavReturn(latestPrice, anchorPrice, daysDelta);
  // B12 — the NAV-oracle annualization is unbounded on a short anchor window; the
  // shared deterministic envelope keeps an absurd print out of PYS.
  if (typeof apy !== "number" || !isDeterministicApyWithinSanityBounds(apy)) return null;

  return {
    currentApy: apy, apyBase: apy, apyReward: null,
    sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
    exchangeRate: null, sourceKey: OPTIONAL_YIELD_SOURCES.hashnote.sourceKey,
    yieldSource: OPTIONAL_YIELD_SOURCES.hashnote.yieldSource, yieldType: OPTIONAL_YIELD_SOURCES.hashnote.yieldType,
    sourceObservedAt: latestTimeSec,
    comparisonAnchorObservedAt: anchorTimeSec,
  };
}

export async function fetchOndoUsdyOracleSource(
  prevExchangeRate: number | null,
  daysDelta: number,
  comparisonAnchorObservedAt: number | null,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<ResolvedYield | null> {
  const rpc = chainRpcs ? getChainRpc(chainRpcs, "ethereum") : undefined;
  const fallbackRpcUrl = registryRpcUrls(rpc)[1];
  const extraRpcUrls = fallbackRpcUrl ? [fallbackRpcUrl] : [];
  const currentPrice = await fetchEvmUint256AtBlock(
    "ethereum", ONDO_USDY_ORACLE, ONDO_GET_PRICE_SELECTOR, "latest",
    { extraRpcUrls, signal },
  );
  if (!currentPrice || currentPrice === 0n) return null;

  const currentPriceFloat = finiteDecimalNumberFromBigInt(currentPrice, 18);
  if (currentPriceFloat == null || !Number.isFinite(currentPriceFloat) || currentPriceFloat <= 0) return null;

  if (prevExchangeRate == null || prevExchangeRate === 0 || daysDelta < 1) {
    return {
      observationKind: "anchor-only",
      currentApy: 0, apyBase: null, apyReward: null,
      sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
      exchangeRate: currentPriceFloat, sourceKey: OPTIONAL_YIELD_SOURCES.ondo.sourceKey,
      yieldSource: OPTIONAL_YIELD_SOURCES.ondo.yieldSource, yieldType: OPTIONAL_YIELD_SOURCES.ondo.yieldType,
      sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
    };
  }

  if (!Number.isFinite(prevExchangeRate) || prevExchangeRate <= 0) return null;
  const apy = annualizeNavReturn(currentPriceFloat, prevExchangeRate, daysDelta);
  // B12 — same deterministic envelope as the other NAV oracles.
  if (typeof apy !== "number" || !isDeterministicApyWithinSanityBounds(apy)) return null;

  return {
    currentApy: apy, apyBase: apy, apyReward: null,
    sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
    exchangeRate: currentPriceFloat, sourceKey: OPTIONAL_YIELD_SOURCES.ondo.sourceKey,
    yieldSource: OPTIONAL_YIELD_SOURCES.ondo.yieldSource, yieldType: OPTIONAL_YIELD_SOURCES.ondo.yieldType,
    sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt,
  };
}

export async function fetchReProtocolReusdSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  const result = await fetchJsonWithRetry<RePriceResponse>(
    RE_REUSD_PRICE_URL,
    {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
    },
    0,
    { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
  );
  if (!result?.response.ok || result.body.success !== true) return null;

  const observations = result.body.data?.reUSD;
  if (!Array.isArray(observations) || observations.length === 0) return null;

  const parsed = observations
    .map((observation) => {
      const observedAt = typeof observation.date === "string"
        ? Date.parse(`${observation.date}T00:00:00Z`) / 1000
        : Number.NaN;
      return {
        apy: getFiniteNumber(observation.apy),
        observedAt,
        price: getFiniteNumber(observation.price),
      };
    })
    .filter((observation) =>
      observation.apy != null &&
      observation.apy >= RE_REUSD_MIN_APY_PERCENT &&
      observation.apy <= RE_REUSD_MAX_APY_PERCENT &&
      Number.isFinite(observation.observedAt) &&
      observation.price != null &&
      observation.price > 0,
    )
    .sort((a, b) => b.observedAt - a.observedAt);
  const latest = parsed[0];
  if (!latest || latest.apy == null || latest.price == null) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (latest.observedAt > nowSec || nowSec - latest.observedAt > RE_REUSD_MAX_FRESHNESS_SEC) {
    return null;
  }

  return {
    currentApy: latest.apy,
    apyBase: latest.apy,
    apyReward: null,
    sourcePool: RE_REUSD_CONTRACT,
    sourceTvlUsd: null,
    dataSource: "protocol-api",
    exchangeRate: latest.price,
    sourceKey: OPTIONAL_YIELD_SOURCES.re.sourceKey,
    yieldSource: OPTIONAL_YIELD_SOURCES.re.yieldSource,
    yieldType: OPTIONAL_YIELD_SOURCES.re.yieldType,
    sourceObservedAt: latest.observedAt,
    comparisonAnchorObservedAt: null,
  };
}

const MIDAS_MMEV_SYMBOL = "mMEV";
const MIDAS_MMEV_CHAIN = "ethereum";
const MIDAS_MMEV_TOKEN = "0x030b69280892c888670edcdcd8b69fd8026a0bf3";
const MIDAS_MMEV_NAV_ORACLE = "0x5f09Aff8B9b1f488B7d1bbaD4D89648579e55d61";
const MIDAS_MMEV_NAV_ORACLE_MAX_AGE_SEC = 3 * DAY_SECONDS;
const MIDAS_NAV_ORACLE_MAX_DECIMALS = 36;
const MIDAS_NAV_ORACLE_MAX_FUTURE_SKEW_SEC = 5 * 60;

interface MidasMmevNavOracleOptions {
  loadAnchor: (observedAt: number) => Promise<{ exchangeRate: number; observedAt: number } | null>;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  nowSec?: number;
}

function decodeMidasNavOracleDecimals(rawDecimals: bigint | null): number | null {
  if (rawDecimals == null || rawDecimals < 0n || rawDecimals > BigInt(MIDAS_NAV_ORACLE_MAX_DECIMALS)) {
    return null;
  }
  return Number(rawDecimals);
}

function isFreshMidasNavOracleUpdate(updatedAt: number, nowSec: number): boolean {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  if (updatedAt > nowSec + MIDAS_NAV_ORACLE_MAX_FUTURE_SKEW_SEC) return false;
  return nowSec - updatedAt <= MIDAS_MMEV_NAV_ORACLE_MAX_AGE_SEC;
}

function buildMidasMmevNavCandidate(params: {
  observationKind?: "anchor-only";
  apy: number;
  apyBase: number | null;
  exchangeRate: number;
  sourceObservedAt: number;
  comparisonAnchorObservedAt: number | null;
}): ResolvedYieldCandidate {
  return {
    stablecoinId: OPTIONAL_YIELD_SOURCES.midas.stablecoinId,
    symbol: MIDAS_MMEV_SYMBOL,
    chain: MIDAS_MMEV_CHAIN,
    address: MIDAS_MMEV_TOKEN,
    yield: {
      observationKind: params.observationKind,
      currentApy: params.apy,
      apyBase: params.apyBase,
      apyReward: null,
      sourcePool: MIDAS_MMEV_NAV_ORACLE,
      sourceTvlUsd: null,
      dataSource: "protocol-api",
      exchangeRate: params.exchangeRate,
      sourceKey: OPTIONAL_YIELD_SOURCES.midas.sourceKey,
      yieldSource: OPTIONAL_YIELD_SOURCES.midas.yieldSource,
      yieldType: OPTIONAL_YIELD_SOURCES.midas.yieldType,
      sourceObservedAt: params.sourceObservedAt,
      comparisonAnchorObservedAt: params.comparisonAnchorObservedAt,
    },
  };
}

export async function fetchMidasMmevNavOracleSource(
  options: MidasMmevNavOracleOptions,
): Promise<ResolvedYieldCandidate | null> {
  const {
    loadAnchor,
    signal,
    chainRpcs,
    nowSec = Math.floor(Date.now() / 1000),
  } = options;

  const callOptions = {
    chainRpcs,
    signal,
    timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  };
  const [rawDecimals, rawRoundData] = await Promise.all([
    fetchEvmUint256AtBlock(
      MIDAS_MMEV_CHAIN,
      MIDAS_MMEV_NAV_ORACLE,
      DECIMALS_SELECTOR,
      "latest",
      callOptions,
    ),
    fetchEvmCallHexAtBlock(
      MIDAS_MMEV_CHAIN,
      MIDAS_MMEV_NAV_ORACLE,
      LATEST_ROUND_DATA_SELECTOR,
      "latest",
      callOptions,
    ),
  ]);

  const decimals = decodeMidasNavOracleDecimals(rawDecimals);
  if (decimals == null || rawRoundData == null) return null;

  const round = parseChainlinkLatestRoundData(rawRoundData, "midas-mmev-nav-oracle");
  if (round.invalidReason) return null;
  if (!isFreshMidasNavOracleUpdate(round.updatedAt, nowSec)) return null;

  const currentPriceFloat = finiteDecimalNumberFromBigInt(round.answer, decimals);
  if (currentPriceFloat == null || currentPriceFloat <= 0) return null;

  const anchor = await loadAnchor(round.updatedAt);
  const prevPriceFloat = typeof anchor?.exchangeRate === "number" && Number.isFinite(anchor.exchangeRate) && anchor.exchangeRate > 0
    ? anchor.exchangeRate : null;
  const anchorObservedAt = anchor?.observedAt;
  const daysDelta = typeof anchorObservedAt === "number" && Number.isFinite(anchorObservedAt)
    ? (round.updatedAt - anchorObservedAt) / DAY_SECONDS : 0;

  if (prevPriceFloat == null || anchorObservedAt == null) {
    return buildMidasMmevNavCandidate({
      observationKind: "anchor-only",
      apy: 0,
      apyBase: null,
      exchangeRate: currentPriceFloat,
      sourceObservedAt: round.updatedAt,
      comparisonAnchorObservedAt: null,
    });
  }
  if (!Number.isFinite(daysDelta) || daysDelta < 1 || daysDelta > 45) return null;

  const apy = annualizeNavReturn(currentPriceFloat, prevPriceFloat, daysDelta);
  // B12 — a short or mis-anchored window annualizes without bound; the shared
  // deterministic envelope keeps an absurd NAV move out of PYS (and out of the
  // published board) instead of clamping it to a perfect score.
  if (typeof apy !== "number" || !isDeterministicApyWithinSanityBounds(apy)) return null;

  return buildMidasMmevNavCandidate({
    apy,
    apyBase: apy,
    exchangeRate: currentPriceFloat,
    sourceObservedAt: round.updatedAt,
    comparisonAnchorObservedAt: anchorObservedAt ?? null,
  });
}
