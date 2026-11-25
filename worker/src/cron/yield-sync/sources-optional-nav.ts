import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getUsycNavFreshness, OPTIONAL_YIELD_SOURCES, USYC_NAV_FUTURE_SKEW_SEC } from "@shared/lib/yield-source-cadence";
import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { computeApyFromRate, isDeterministicApyWithinSanityBounds } from "../yield-helpers";
import { getFiniteNumber, OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS } from "./sources-rpc";
import type { ResolvedYield } from "./types";

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
      && report.parsedTimestamp <= nowSec + USYC_NAV_FUTURE_SKEW_SEC)
    .sort((a, b) => b.parsedTimestamp - a.parsedTimestamp);
  if (sortedReports.length < 2) return null;

  const latest = sortedReports[0];
  const latestPrice = parseFloat(latest.price);
  const latestTimeSec = latest.parsedTimestamp;
  if (!Number.isFinite(latestPrice) || latestPrice <= 0) return null;
  const freshness = getUsycNavFreshness(latestTimeSec, nowSec);
  if (freshness !== "fresh" && freshness !== "aging") return null;

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
