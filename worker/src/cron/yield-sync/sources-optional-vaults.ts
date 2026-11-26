import { getCronJobMeta } from "@shared/lib/cron-jobs";
import { parseRetryAfterSeconds } from "@shared/lib/retry-after";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { isRecord } from "@shared/lib/type-guards";
import { MORPHO_NET_YIELD_SOURCES, OPTIONAL_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
import { CHAIN_META, normalizeChainId } from "@shared/types/chain-identity";
import { FetchRequestNotStartedError, throwIfAborted } from "../../lib/abort";
import { finiteDecimalNumberFromBigInt } from "../../lib/bigint";
import { USER_AGENT } from "../../lib/constants";
import { DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES, fetchJsonWithRetry, fetchWithRetry } from "../../lib/fetch-retry";
import { resolveMorphoRateLimitBackoff } from "../../lib/morpho-rate-limit";
import { cancelResponseBodyQuietly, readResponseJsonWithinLimitWithSignal } from "../../lib/response-body";
import { logWorkerEvent } from "../../lib/structured-log";
import { PENDLE_SUPPLEMENTAL_FETCH_CADENCE_SEC, STALE_THRESHOLD_MS } from "../../lib/yield-ranking-helpers";
import { isDeterministicApyWithinSanityBounds } from "../yield-helpers";
import {
  createOptionalSourceBudget,
  getFiniteNumber,
  OPTIONAL_PROTOCOL_API_BUDGET_MS,
  OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
} from "./sources-rpc";
import { buildMorphoFilters, resolveMorphoTrackedAsset } from "./optional-source-identity";
import type { ResolvedYield, ResolvedYieldCandidate } from "./types";

interface YdaemonVault {
  address?: string;
  /** ydaemon exposes the vault's underlying deposit token as `token`. */
  token?: { address?: string };
  tvl?: { tvl?: number };
  apr?: { netAPR?: number };
  info?: { isRetired?: boolean };
}

const YEARN_YBOLD_VAULT = "0x9f4330700a36b29952869fac9b33f45eedd8a3d8";
const YEARN_YSYBOLD_VAULT = "0x23346b04a7f55b8760e5860aa5a77383d63491cd";
const LIQUITY_BOLD_TOKEN = "0x6440f144b7e50d6a8439336510312d2f54beb01d";
const YDAEMON_ETHEREUM_VAULT_URL = "https://ydaemon.yearn.fi/1/vaults/";
const YEARN_YBOLD_MIN_TVL_USD = 100_000;
const YEARN_YBOLD_MAX_APY_PERCENT = 100;

/**
 * Yearn's first-party yBOLD numbers, read from ydaemon.
 *
 * yBOLD itself holds a flat 1.0 price-per-share: Yearn routes the Liquity V2
 * Stability Pool return to holders who stake yBOLD into `ysyBOLD`, so the
 * advertised yBOLD yield is the staked vault's net APR. TVL stays the yBOLD
 * vault's own TVL. The adapter fails closed unless yBOLD still wraps BOLD and
 * ysyBOLD still wraps the tracked yBOLD vault, so a Yearn restructure cannot
 * silently publish an unrelated vault's return under yBOLD.
 */
export async function fetchYearnYboldSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  const yboldResult = await fetchJsonWithRetry<YdaemonVault>(
    `${YDAEMON_ETHEREUM_VAULT_URL}${YEARN_YBOLD_VAULT}`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
    0,
    { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
  );
  if (!yboldResult?.response.ok) return null;
  if (yboldResult.body.info?.isRetired) return null;
  if (yboldResult.body.token?.address?.toLowerCase() !== LIQUITY_BOLD_TOKEN) return null;

  const sourceTvlUsd = getFiniteNumber(yboldResult.body.tvl?.tvl);
  if (sourceTvlUsd == null || sourceTvlUsd < YEARN_YBOLD_MIN_TVL_USD) return null;

  const stakedResult = await fetchJsonWithRetry<YdaemonVault>(
    `${YDAEMON_ETHEREUM_VAULT_URL}${YEARN_YSYBOLD_VAULT}`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
    0,
    { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
  );
  if (!stakedResult?.response.ok) return null;
  if (stakedResult.body.info?.isRetired) return null;
  if (stakedResult.body.token?.address?.toLowerCase() !== YEARN_YBOLD_VAULT) return null;

  const netApr = getFiniteNumber(stakedResult.body.apr?.netAPR);
  if (netApr == null) return null;

  const apy = netApr * 100;
  if (apy <= 0 || apy > YEARN_YBOLD_MAX_APY_PERCENT) return null;

  return {
    currentApy: apy,
    apyBase: apy,
    apyReward: null,
    sourcePool: YEARN_YBOLD_VAULT,
    sourceTvlUsd,
    dataSource: "protocol-api",
    exchangeRate: null,
    sourceKey: OPTIONAL_YIELD_SOURCES.ybold.sourceKey,
    yieldSource: OPTIONAL_YIELD_SOURCES.ybold.yieldSource,
    yieldType: OPTIONAL_YIELD_SOURCES.ybold.yieldType,
    sourceObservedAt: null,
    sourceFetchedAt: Math.floor(Date.now() / 1000),
    comparisonAnchorObservedAt: null,
  };
}

const MORPHO_REST_V0_BASE_URL = "https://api.morpho.org/v0";
const ETHEREUM_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ETHEREUM_USDC_DECIMALS = 6;
const MORPHO_FEE_WAD_MAX = 10n ** 18n;
const MORPHO_PRICE_FUTURE_SKEW_SEC = 5 * 60;
const MORPHO_REST_MAX_RESPONSE_BYTES = 16 * 1024;
const MORPHO_REST_LIST_MAX_RESPONSE_BYTES = 1024 * 1024;
const MORPHO_REST_LIST_LIMIT = 1000;
const MORPHO_REST_LIST_MAX_PAGES = 10;
const MORPHO_REST_CONCURRENCY = getCronJobMeta("sync-yield-supplemental")!.maxConnections!;

function parseUnsignedBigInt(value: unknown): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

function parseMorphoUnixTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function parseMorphoRestStateTotalAssets(
  stateBody: Record<string, unknown>,
  expectedChainId: number,
  expectedVaultAddressLower: string,
): bigint | null {
  if (stateBody.data === null) return null;
  if (!isRecord(stateBody.data)) throw new Error("Malformed Morpho V1 vault state");
  if (
    stateBody.data.chain_id !== expectedChainId ||
    typeof stateBody.data.address !== "string" ||
    stateBody.data.address.toLowerCase() !== expectedVaultAddressLower
  ) {
    throw new Error("Morpho V1 vault state identity mismatch");
  }
  if (stateBody.data.total_assets === undefined) throw new Error("Incomplete Morpho V1 vault state");
  if (stateBody.data.total_assets === null) return null;
  const totalAssetsRaw = parseUnsignedBigInt(stateBody.data.total_assets);
  if (totalAssetsRaw == null) throw new Error("Malformed Morpho V1 vault state");
  return totalAssetsRaw > 0n ? totalAssetsRaw : null;
}

function parseMorphoRestLatestApyPoint(
  historyBody: Record<string, unknown>,
  expectedChainId: number,
  expectedVaultAddressLower: string,
  referenceSec: number,
  apyCheckedAtSec: number,
): { netApy: number; sourceObservedAt: number } | null {
  const historyParams = historyBody.params;
  if (
    !isRecord(historyParams) ||
    (historyParams.chain_id !== String(expectedChainId) && historyParams.chain_id !== expectedChainId) ||
    typeof historyParams.vault_address !== "string" ||
    historyParams.vault_address.toLowerCase() !== expectedVaultAddressLower
  ) {
    throw new Error("Morpho V1 vault APY history identity mismatch");
  }
  if (historyBody.data === null) return null;
  if (!Array.isArray(historyBody.data)) throw new Error("Malformed Morpho V1 vault APY history");
  if (historyBody.data.length === 0) return null;

  let latestPoint: Record<string, unknown> | null = null;
  let sourceObservedAt = -Infinity;
  const lastHistoryItem = historyBody.data[historyBody.data.length - 1];
  for (const point of historyBody.data) {
    if (!isRecord(point) || point.timestamp === undefined || point.apy === undefined) {
      throw new Error("Incomplete Morpho V1 vault APY history");
    }
    if (point.timestamp === null) {
      if (point === lastHistoryItem) return null;
      continue;
    }
    const ts = parseMorphoUnixTimestamp(point.timestamp);
    if (ts == null) throw new Error("Malformed Morpho V1 vault APY history");
    if (ts >= sourceObservedAt) {
      sourceObservedAt = ts;
      latestPoint = point;
    }
  }
  if (!latestPoint) return null;
  if (latestPoint.apy === null) return null;
  if (typeof latestPoint.apy !== "number") throw new Error("Malformed Morpho V1 vault APY history");
  const netApy = getFiniteNumber(latestPoint.apy);
  if (netApy == null) return null;

  if (
    sourceObservedAt > Math.min(referenceSec, apyCheckedAtSec) ||
    (referenceSec - sourceObservedAt) * 1000 > STALE_THRESHOLD_MS
  ) {
    return null;
  }
  return { netApy, sourceObservedAt };
}

function parseMorphoRestTokenPrice(
  priceBody: Record<string, unknown>,
  expectedChainId: number,
  expectedAssetAddressLower: string,
  referenceSec: number,
  fetchedAtSec: number,
): number | null {
  if (priceBody.data === null) return null;
  if (
    !isRecord(priceBody.data) ||
    priceBody.data.chain_id !== expectedChainId ||
    typeof priceBody.data.address !== "string" ||
    priceBody.data.address.toLowerCase() !== expectedAssetAddressLower
  ) {
    throw new Error("Morpho V1 token price identity mismatch");
  }
  if (priceBody.data.price === undefined || priceBody.data.timestamp === undefined) {
    throw new Error("Incomplete Morpho V1 token price");
  }
  if (priceBody.data.price === null || priceBody.data.timestamp === null) return null;
  if (typeof priceBody.data.price !== "number") throw new Error("Malformed Morpho V1 token price");
  const assetPriceUsd = getFiniteNumber(priceBody.data.price);
  const priceTimestamp = parseMorphoUnixTimestamp(priceBody.data.timestamp);
  if (priceTimestamp == null) throw new Error("Malformed Morpho V1 token price");

  const maxPriceTimestamp = Math.min(fetchedAtSec, referenceSec + MORPHO_PRICE_FUTURE_SKEW_SEC);
  if (
    assetPriceUsd == null ||
    assetPriceUsd <= 0 ||
    priceTimestamp > maxPriceTimestamp ||
    (referenceSec - priceTimestamp) * 1000 > STALE_THRESHOLD_MS
  ) {
    return null;
  }
  return assetPriceUsd;
}

async function fetchMorphoRestJson(
  path: string,
  signal: AbortSignal,
  errorMessage: string,
): Promise<Record<string, unknown>> {
  throwIfAborted(signal);
  const result = await fetchJsonWithRetry<unknown>(
    `${MORPHO_REST_V0_BASE_URL}${path}`,
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
    0,
    { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS, maxResponseBytes: MORPHO_REST_MAX_RESPONSE_BYTES },
  );
  if (!result?.response.ok || !isRecord(result.body)) {
    throw new Error(errorMessage);
  }
  return result.body;
}

export async function fetchMorphoNetVaultSource(
  config: typeof MORPHO_NET_YIELD_SOURCES[keyof typeof MORPHO_NET_YIELD_SOURCES],
  startSec: number,
  signal: AbortSignal,
): Promise<ResolvedYield | null> {
  const vaultKey = `1:${config.vaultAddress}`;

  const vaultBody = await fetchMorphoRestJson(`/vaults-v1/${vaultKey}`, signal, "Morpho V1 vault query failed");
  const vault = vaultBody.data;
  if (
    !isRecord(vault) ||
    vault.chain_id !== 1 ||
    typeof vault.address !== "string" ||
    vault.address.toLowerCase() !== config.vaultAddress
  ) {
    throw new Error("Morpho V1 vault identity mismatch");
  }
  if (
    !isRecord(vault.asset) ||
    typeof vault.asset.address !== "string" ||
    vault.asset.address.toLowerCase() !== ETHEREUM_USDC_ADDRESS ||
    vault.asset.decimals !== ETHEREUM_USDC_DECIMALS
  ) {
    throw new Error("Morpho V1 vault asset identity mismatch");
  }
  if (vault.fee_wad === undefined) throw new Error("Incomplete Morpho V1 vault metadata");
  if (vault.fee_wad === null) return null;
  const feeWad = parseUnsignedBigInt(vault.fee_wad);
  if (feeWad == null) throw new Error("Malformed Morpho V1 vault metadata");
  if (feeWad <= 0n || feeWad > MORPHO_FEE_WAD_MAX) return null;

  const stateBody = await fetchMorphoRestJson(
    `/vaults-v1/${vaultKey}/state`,
    signal,
    "Morpho V1 vault state query failed",
  );
  const totalAssetsRaw = parseMorphoRestStateTotalAssets(stateBody, 1, config.vaultAddress);
  if (totalAssetsRaw == null) return null;

  const historyBody = await fetchMorphoRestJson(
    `/vaults-v1/${vaultKey}/apy/history?lookback=six_hours`,
    signal,
    "Morpho V1 vault APY history query failed",
  );
  const apyCheckedAt = Math.floor(Date.now() / 1000);
  const latestApy = parseMorphoRestLatestApyPoint(historyBody, 1, config.vaultAddress, startSec, apyCheckedAt);
  if (latestApy == null) return null;

  const currentApy = latestApy.netApy * 100;
  if (currentApy < -100 || !isDeterministicApyWithinSanityBounds(currentApy)) return null;

  const priceBody = await fetchMorphoRestJson(
    `/tokens/1:${ETHEREUM_USDC_ADDRESS}/price`,
    signal,
    "Morpho V1 token price query failed",
  );
  const sourceFetchedAt = Math.floor(Date.now() / 1000);
  const assetPriceUsd = parseMorphoRestTokenPrice(priceBody, 1, ETHEREUM_USDC_ADDRESS, startSec, sourceFetchedAt);
  if (assetPriceUsd == null) return null;

  const totalAssets = finiteDecimalNumberFromBigInt(totalAssetsRaw, ETHEREUM_USDC_DECIMALS);
  const sourceTvlUsd = totalAssets != null ? totalAssets * assetPriceUsd : null;
  if (sourceTvlUsd == null || !Number.isFinite(sourceTvlUsd) || sourceTvlUsd <= 0) return null;

  return {
    currentApy,
    apyBase: currentApy,
    apyReward: null,
    sourcePool: config.corroboratingPoolId,
    sourceTvlUsd,
    dataSource: "protocol-api",
    exchangeRate: null,
    sourceKey: config.sourceKey,
    yieldSource: config.yieldSource,
    yieldType: config.yieldType,
    project: config.venueProtocol,
    chain: "ethereum",
    sourceObservedAt: latestApy.sourceObservedAt,
    sourceFetchedAt,
    comparisonAnchorObservedAt: null,
  };
}

interface PendleMarket {
  id: string;
  address: string;
  chainId: number;
  isActive: boolean;
  expiry: string;
  impliedApy: number;
  underlyingApy: number;
  aggregatedApy: number;
  underlyingAsset: { symbol: string; address: string };
  assetRepresentation: string;
  protocol: string;
  liquidity: { usd: number };
  categoryIds: string[];
}

interface KongVault {
  address: string;
  name: string;
  yearn: boolean;
  asset: { symbol: string; address?: string | null };
  tvl: { close: number } | null;
  apy: { net: number | null; blockTime?: string | null } | null;
  meta: { category: string | null; isRetired: boolean | null } | null;
}

interface BeefyVault {
  id: string;
  name: string;
  token: string;
  assets: string[];
  status: string;
  chain: string;
  platformId: string;
  tokenAddress: string;
}

type BeefyTvlPayload = Record<string, number | null | Record<string, number | null>>;

const BEEFY_CHAIN_ALIASES: Record<string, string> = {
  avax: "avalanche",
  one: "harmony",
  zkevm: "polygon-zkevm",
};

/**
 * B1: supplemental fetchers report whether an HTTP/parse failure or a partial
 * pagination ended the run early, so the writer can retain the previous family
 * snapshot instead of publishing a fresh, incomplete one.
 */
export interface SupplementalFamilyFetchResult {
  candidates: ResolvedYieldCandidate[];
  degraded: boolean;
  /** Machine-readable cause when degraded (R4). */
  degradedReason?: string;
  /** A 429's retry window, persisted by the supplemental producer. */
  rateLimited?: SupplementalRateLimitBackoff;
}

interface SupplementalRateLimitBackoff {
  backoffSec: number;
  source: "retry-after" | "x-ratelimit-weekly-reset" | "x-ratelimit-reset" | "default";
}

/** Respect the exhausted quota window, not the weekly reset on an ordinary minute-limit response. */
function resolvePendleRateLimitBackoff(response: Response, nowMs: number): SupplementalRateLimitBackoff {
  const retryAfterSec = parseRetryAfterSeconds(response.headers.get("Retry-After"), { nowMs });
  const weeklyRemaining = response.headers.get("x-ratelimit-weekly-remaining");
  const weeklyExhausted = weeklyRemaining != null && Number(weeklyRemaining) === 0;
  const resetHeaders = weeklyExhausted || (weeklyRemaining == null && !retryAfterSec)
    ? ["x-ratelimit-weekly-reset", "x-ratelimit-reset"] as const
    : ["x-ratelimit-reset"] as const;
  let backoffSec = retryAfterSec && retryAfterSec > 0 ? retryAfterSec : 0;
  let source: SupplementalRateLimitBackoff["source"] = backoffSec ? "retry-after" : "default";
  for (const header of resetHeaders) {
    const resetSec = Number(response.headers.get(header));
    const delaySec = resetSec - Math.floor(nowMs / 1000);
    if (Number.isSafeInteger(resetSec) && delaySec > backoffSec) {
      backoffSec = delaySec;
      source = header;
    }
  }
  return {
    backoffSec: backoffSec > 0 ? Math.min(backoffSec, 7 * 86400) : PENDLE_SUPPLEMENTAL_FETCH_CADENCE_SEC,
    source,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveBeefyCanonicalChain(chain: string | null | undefined): string | null {
  if (!isNonEmptyString(chain)) return null;
  const alias = BEEFY_CHAIN_ALIASES[chain.toLowerCase()];
  return normalizeChainId(alias ?? chain);
}

function resolveBeefyTvl(tvlMap: BeefyTvlPayload, chain: string, vaultId: string): number | null {
  const evmChainId = CHAIN_META[chain]?.evmChainId;
  if (evmChainId != null) {
    const chainTvlMap = tvlMap[String(evmChainId)];
    if (chainTvlMap && typeof chainTvlMap === "object" && !Array.isArray(chainTvlMap)) {
      return chainTvlMap[vaultId] ?? null;
    }
  }

  const flatTvl = tvlMap[vaultId];
  return typeof flatTvl === "number" ? flatTvl : null;
}

const MORPHO_MIN_TVL_USD = 100_000;
const PENDLE_MIN_EXPIRY_DAYS = 3;
const PENDLE_MAX_EXPIRY_YEARS = 5;
const PENDLE_MAX_IMPLIED_APY = 1;
const PENDLE_MIN_TVL_USD = 100_000;
const KONG_MIN_TVL_USD = 100_000;
const BEEFY_MAX_APY = 0.5;
const BEEFY_MIN_TVL_USD = 100_000;

function isSanePendleExpiry(expiry: string, nowMs: number): boolean {
  const expiryMs = Date.parse(expiry);
  if (!Number.isFinite(expiryMs)) return false;

  const minExpiryMs = nowMs + PENDLE_MIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const maxExpiryMs = nowMs + PENDLE_MAX_EXPIRY_YEARS * 365.25 * 24 * 60 * 60 * 1000;
  return expiryMs >= minExpiryMs && expiryMs <= maxExpiryMs;
}

function buildSupplementalCandidate(
  identity: Omit<ResolvedYieldCandidate, "yield">,
  currentApy: number,
  sourcePool: string,
  sourceTvlUsd: number,
  sourceKey: string,
  yieldSource: string,
  yieldType: NonNullable<ResolvedYield["yieldType"]>,
  sourceFetchedAt: number,
  sourceObservedAt: number | null = null,
): ResolvedYieldCandidate {
  return {
    ...identity,
    yield: {
      currentApy,
      apyBase: currentApy,
      apyReward: null,
      sourcePool,
      sourceTvlUsd,
      dataSource: "protocol-api",
      exchangeRate: null,
      sourceKey,
      yieldSource,
      yieldType,
      sourceObservedAt,
      sourceFetchedAt,
      comparisonAnchorObservedAt: null,
    },
  };
}

type MorphoSupplementalFetchOutcome =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "rate-limited"; rateLimited: SupplementalRateLimitBackoff }
  | { kind: "http-error" }
  | { kind: "malformed" };

interface TrackedMorphoV1Vault {
  chainId: number;
  chain: string;
  vaultAddress: string;
  vaultAddressLower: string;
  name: string;
  assetAddress: string;
  assetAddressLower: string;
  assetSelector: string;
  stablecoinId: string;
  symbol: string;
  decimals: number;
}

export async function fetchMorphoVaultSources(signal?: AbortSignal): Promise<SupplementalFamilyFetchResult> {
  const budget = createOptionalSourceBudget("Morpho vault sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  const rateLimitController = new AbortController();
  const requestSignal = AbortSignal.any([budget.signal, rateLimitController.signal]);
  let sharedRateLimited: SupplementalRateLimitBackoff | null = null;

  const fetchMorphoSupplementalRestJson = async (
    path: string,
    maxResponseBytes: number,
  ): Promise<MorphoSupplementalFetchOutcome> => {
    if (sharedRateLimited) return { kind: "rate-limited", rateLimited: sharedRateLimited };
    throwIfAborted(budget.budgetController.signal);
    if (signal?.aborted) throwIfAborted(signal);
    try {
      const response = await fetchWithRetry(
        `${MORPHO_REST_V0_BASE_URL}${path}`,
        {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: requestSignal,
        },
        1,
        {
          timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS,
          deadlineMs: budget.deadlineMs,
          passthroughStatuses: [429],
          waitOnPassthrough429: false,
          beforeRequest: () => sharedRateLimited == null,
        },
      );
      if (sharedRateLimited) {
        if (response) await cancelResponseBodyQuietly(response);
        return { kind: "rate-limited", rateLimited: sharedRateLimited };
      }
      if (!response) return { kind: "http-error" };
      if (response.status === 429) {
        const rateLimited = resolveMorphoRateLimitBackoff(response, Date.now());
        await cancelResponseBodyQuietly(response);
        if (!sharedRateLimited) {
          sharedRateLimited = rateLimited;
          rateLimitController.abort(new Error("Morpho REST API rate limited"));
        }
        return { kind: "rate-limited", rateLimited };
      }
      if (!response.ok) {
        await cancelResponseBodyQuietly(response);
        return { kind: "http-error" };
      }
      const remainingMs = budget.deadlineMs - Date.now();
      if (remainingMs <= 0) {
        await cancelResponseBodyQuietly(response);
        throw new FetchRequestNotStartedError("deadline-exceeded", 1);
      }
      const bodyTimeout = createTimeoutSignal({
        timeoutMs: Math.min(OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS, remainingMs),
        timeoutReason: new DOMException("Morpho REST response body timed out", "TimeoutError"),
        parentSignal: requestSignal,
      });
      try {
        const body = await readResponseJsonWithinLimitWithSignal<unknown>(
          response,
          maxResponseBytes,
          bodyTimeout.signal,
        );
        if (!isRecord(body)) return { kind: "malformed" };
        return { kind: "ok", body };
      } finally {
        bodyTimeout.dispose();
      }
    } catch (error) {
      if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
      if (sharedRateLimited) return { kind: "rate-limited", rateLimited: sharedRateLimited };
      if (budget.budgetController.signal.aborted || error instanceof FetchRequestNotStartedError) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      return { kind: "malformed" };
    }
  };

  try {
    const filters = buildMorphoFilters();
    if (filters.assetsByChainAddress.size === 0) return { candidates: [], degraded: false };
    const startSec = Math.floor(Date.now() / 1000);

    // Stage 1: paginated V1 vault directory.
    const trackedVaults: TrackedMorphoV1Vault[] = [];
    const seenCursors = new Set<string>();
    const seenVaultKeys = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;
    while (true) {
      throwIfAborted(budget.budgetController.signal);
      if (pageCount >= MORPHO_REST_LIST_MAX_PAGES) {
        return { candidates: [], degraded: true, degradedReason: "morpho-fetch-failed" };
      }
      const path = cursor
        ? `/vaults-v1?limit=${MORPHO_REST_LIST_LIMIT}&cursor=${encodeURIComponent(cursor)}`
        : `/vaults-v1?limit=${MORPHO_REST_LIST_LIMIT}`;
      const outcome = await fetchMorphoSupplementalRestJson(path, MORPHO_REST_LIST_MAX_RESPONSE_BYTES);
      if (outcome.kind === "rate-limited") {
        return { candidates: [], degraded: true, rateLimited: outcome.rateLimited };
      }
      if (outcome.kind !== "ok" || !Array.isArray(outcome.body.data)) {
        return { candidates: [], degraded: true, degradedReason: "morpho-fetch-failed" };
      }
      pageCount += 1;

      for (const item of outcome.body.data) {
        if (!isRecord(item)) continue;
        if (typeof item.chain_id !== "number" || !Number.isSafeInteger(item.chain_id) || item.chain_id <= 0) {
          continue;
        }
        const chain = normalizeChainId(item.chain_id);
        if (!chain) continue;
        if (
          !isNonEmptyString(item.vault_address) ||
          !isNonEmptyString(item.name) ||
          !isNonEmptyString(item.asset_address)
        ) {
          continue;
        }
        const trackedAsset = resolveMorphoTrackedAsset(filters, chain, item.asset_address);
        if (!trackedAsset) continue;
        const vaultAddressLower = item.vault_address.toLowerCase();
        const dedupeKey = `${item.chain_id}:${vaultAddressLower}`;
        if (seenVaultKeys.has(dedupeKey)) continue;
        seenVaultKeys.add(dedupeKey);
        const assetAddressLower = item.asset_address.toLowerCase();
        trackedVaults.push({
          chainId: item.chain_id,
          chain,
          vaultAddress: item.vault_address,
          vaultAddressLower,
          name: item.name,
          assetAddress: item.asset_address,
          assetAddressLower,
          assetSelector: `${item.chain_id}:${assetAddressLower}`,
          stablecoinId: trackedAsset.stablecoinId,
          symbol: trackedAsset.symbol,
          decimals: trackedAsset.decimals,
        });
      }

      const nextCursor = outcome.body.cursor;
      if (nextCursor === undefined || nextCursor === null || nextCursor === "") break;
      if (typeof nextCursor !== "string" || seenCursors.has(nextCursor)) {
        return { candidates: [], degraded: true, degradedReason: "morpho-fetch-failed" };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (trackedVaults.length === 0) return { candidates: [], degraded: false };

    // Stage 2: deduplicated underlying token USD prices (missing price degrades family).
    const uniqueAssets = new Map<string, { chainId: number; assetAddressLower: string }>();
    for (const vault of trackedVaults) {
      if (!uniqueAssets.has(vault.assetSelector)) {
        uniqueAssets.set(vault.assetSelector, {
          chainId: vault.chainId,
          assetAddressLower: vault.assetAddressLower,
        });
      }
    }
    const assetList = [...uniqueAssets.entries()];
    const priceByAssetSelector = new Map<string, number>();
    for (let offset = 0; offset < assetList.length; offset += MORPHO_REST_CONCURRENCY) {
      throwIfAborted(budget.budgetController.signal);
      const chunk = assetList.slice(offset, offset + MORPHO_REST_CONCURRENCY);
      const responses = await Promise.all(
        chunk.map(async ([selector, asset]) => ({
          selector,
          asset,
          outcome: await fetchMorphoSupplementalRestJson(`/tokens/${selector}/price`, MORPHO_REST_MAX_RESPONSE_BYTES),
          fetchedAt: Math.floor(Date.now() / 1000),
        })),
      );
      if (sharedRateLimited) {
        return { candidates: [], degraded: true, rateLimited: sharedRateLimited };
      }
      for (const { selector, asset, outcome, fetchedAt } of responses) {
        if (outcome.kind === "rate-limited") {
          return { candidates: [], degraded: true, rateLimited: outcome.rateLimited };
        }
        if (outcome.kind !== "ok") {
          return { candidates: [], degraded: true, degradedReason: "morpho-token-price-unavailable" };
        }
        let priceUsd: number | null;
        try {
          priceUsd = parseMorphoRestTokenPrice(
            outcome.body,
            asset.chainId,
            asset.assetAddressLower,
            startSec,
            fetchedAt,
          );
        } catch {
          return { candidates: [], degraded: true, degradedReason: "morpho-token-price-unavailable" };
        }
        if (priceUsd == null) {
          return { candidates: [], degraded: true, degradedReason: "morpho-token-price-unavailable" };
        }
        priceByAssetSelector.set(selector, priceUsd);
      }
    }

    // Stage 3: vault state reads and $100k TVL pre-filter.
    const eligibleVaults: Array<TrackedMorphoV1Vault & { sourceTvlUsd: number }> = [];
    for (let offset = 0; offset < trackedVaults.length; offset += MORPHO_REST_CONCURRENCY) {
      throwIfAborted(budget.budgetController.signal);
      const chunk = trackedVaults.slice(offset, offset + MORPHO_REST_CONCURRENCY);
      const responses = await Promise.all(
        chunk.map(async (vault) => ({
          vault,
          outcome: await fetchMorphoSupplementalRestJson(
            `/vaults-v1/${vault.chainId}:${vault.vaultAddressLower}/state`,
            MORPHO_REST_MAX_RESPONSE_BYTES,
          ),
        })),
      );
      if (sharedRateLimited) {
        return { candidates: [], degraded: true, rateLimited: sharedRateLimited };
      }
      for (const { vault, outcome } of responses) {
        if (outcome.kind === "rate-limited") {
          return { candidates: [], degraded: true, rateLimited: outcome.rateLimited };
        }
        if (outcome.kind !== "ok") {
          return { candidates: [], degraded: true, degradedReason: "morpho-fetch-failed" };
        }
        let totalAssetsRaw: bigint | null;
        try {
          totalAssetsRaw = parseMorphoRestStateTotalAssets(
            outcome.body,
            vault.chainId,
            vault.vaultAddressLower,
          );
        } catch {
          return { candidates: [], degraded: true, degradedReason: "morpho-fetch-failed" };
        }
        if (totalAssetsRaw == null) continue;
        const totalAssets = finiteDecimalNumberFromBigInt(totalAssetsRaw, vault.decimals);
        const assetPriceUsd = priceByAssetSelector.get(vault.assetSelector)!;
        const sourceTvlUsd = totalAssets != null ? totalAssets * assetPriceUsd : null;
        if (sourceTvlUsd == null || !Number.isFinite(sourceTvlUsd) || sourceTvlUsd < MORPHO_MIN_TVL_USD) {
          continue;
        }
        eligibleVaults.push({ ...vault, sourceTvlUsd });
      }
    }

    // Stage 4: clocked 6h realized post-fee native APY history for TVL-eligible vaults.
    const results: ResolvedYieldCandidate[] = [];
    for (let offset = 0; offset < eligibleVaults.length; offset += MORPHO_REST_CONCURRENCY) {
      throwIfAborted(budget.budgetController.signal);
      const chunk = eligibleVaults.slice(offset, offset + MORPHO_REST_CONCURRENCY);
      const responses = await Promise.all(
        chunk.map(async (vault) => ({
          vault,
          outcome: await fetchMorphoSupplementalRestJson(
            `/vaults-v1/${vault.chainId}:${vault.vaultAddressLower}/apy/history?lookback=six_hours`,
            MORPHO_REST_MAX_RESPONSE_BYTES,
          ),
          apyCheckedAt: Math.floor(Date.now() / 1000),
        })),
      );
      if (sharedRateLimited) {
        return { candidates: [], degraded: true, rateLimited: sharedRateLimited };
      }
      for (const { vault, outcome, apyCheckedAt } of responses) {
        if (outcome.kind === "rate-limited") {
          return { candidates: [], degraded: true, rateLimited: outcome.rateLimited };
        }
        if (outcome.kind !== "ok") {
          return { candidates: [], degraded: true, degradedReason: "morpho-fetch-failed" };
        }
        let latestApy: { netApy: number; sourceObservedAt: number } | null;
        try {
          latestApy = parseMorphoRestLatestApyPoint(
            outcome.body,
            vault.chainId,
            vault.vaultAddressLower,
            startSec,
            apyCheckedAt,
          );
        } catch {
          return { candidates: [], degraded: true, degradedReason: "morpho-fetch-failed" };
        }
        if (latestApy == null) continue;
        const currentApy = latestApy.netApy * 100;
        if (currentApy <= 0 || !isDeterministicApyWithinSanityBounds(currentApy)) continue;

        results.push(buildSupplementalCandidate(
          {
            stablecoinId: vault.stablecoinId,
            symbol: vault.symbol,
            chain: vault.chain,
            address: vault.assetAddress,
          },
          currentApy,
          vault.vaultAddress,
          vault.sourceTvlUsd,
          `protocol-api:morpho-vault:${vault.chain}:${vault.vaultAddressLower}`,
          `Morpho: ${vault.name}`,
          "lending-opportunity",
          apyCheckedAt,
          latestApy.sourceObservedAt,
        ));
      }
    }

    return { candidates: results, degraded: budget.budgetController.signal.aborted };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (sharedRateLimited) {
      return { candidates: [], degraded: true, rateLimited: sharedRateLimited };
    }
    if (budget.budgetController.signal.aborted || error instanceof FetchRequestNotStartedError) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-yield-supplemental",
        level: "warn",
        event: "morpho-sources-budget-exhausted",
        message: "Morpho vault sources budget exhausted; continuing without this source family",
      });
      return { candidates: [], degraded: true, degradedReason: "morpho-budget-exhausted" };
    }
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-supplemental",
      level: "warn",
      event: "morpho-sources-failed",
      message: "Morpho vault sources failed",
      error,
    });
    return { candidates: [], degraded: true, degradedReason: "morpho-fetch-failed" };
  } finally {
    budget.cleanup();
  }
}

export async function fetchPendleMarketSources(signal?: AbortSignal): Promise<SupplementalFamilyFetchResult> {
  const results: ResolvedYieldCandidate[] = [];
  const budget = createOptionalSourceBudget("Pendle market sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  const nowMs = Date.now();
  let degraded = false;

  try {
    for (const chainId of [1, 42161, 8453]) {
      if (budget.budgetController.signal.aborted) break;
      try {
        let skip = 0;
        const limit = 100;
        while (!budget.budgetController.signal.aborted) {
          throwIfAborted(budget.budgetController.signal);
          const url = `https://api-v2.pendle.finance/core/v1/${chainId}/markets?limit=${limit}&skip=${skip}&is_active=true`;
          const response = await fetchWithRetry(
            url,
            {
              headers: {
                Accept: "application/json",
                "User-Agent": USER_AGENT,
              },
              signal: budget.signal,
            },
            0,
            { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS, passthroughStatuses: [429], waitOnPassthrough429: false },
          );
          if (!response?.ok) {
            degraded = true;
            if (response?.status === 429) {
              const rateLimited = resolvePendleRateLimitBackoff(response, Date.now());
              await cancelResponseBodyQuietly(response);
              // The quota is shared across chains: stop immediately, not after
              // two more doomed requests. Error bodies need not be JSON.
              return { candidates: results, degraded, rateLimited };
            }
            await cancelResponseBodyQuietly(response);
            break;
          }

          const body = await readResponseJsonWithinLimitWithSignal<{ total?: number; results?: PendleMarket[] }>(
            response, DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES, budget.signal,
          );
          const sourceFetchedAt = Math.floor(Date.now() / 1000);
          if (!Array.isArray(body.results)) {
            degraded = true;
            break;
          }
          if (body.results.length === 0) break;

          for (const market of body.results) {
            if (!market.categoryIds?.includes("stables")) continue;
            if (!market.isActive) continue;
            if (!isSanePendleExpiry(market.expiry, nowMs)) continue;

            const apy = market.impliedApy;
            if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > PENDLE_MAX_IMPLIED_APY) {
              continue;
            }

            const tvl = market.liquidity?.usd;
            if (typeof tvl !== "number" || tvl < PENDLE_MIN_TVL_USD) continue;
            if (
              !isNonEmptyString(market.address) ||
              !isNonEmptyString(market.underlyingAsset?.symbol) ||
              !isNonEmptyString(market.underlyingAsset?.address)
            ) {
              continue;
            }
            const chain = normalizeChainId(market.chainId);
            if (!chain) continue;

            results.push(buildSupplementalCandidate(
              { symbol: market.underlyingAsset.symbol, chain, address: market.underlyingAsset.address },
              apy * 100, market.address, tvl,
              `protocol-api:pendle:${chain}:${market.address.toLowerCase()}`,
              `Pendle fixed yield: ${market.protocol} ${market.assetRepresentation}`,
              "fixed-yield", sourceFetchedAt,
            ));
          }

          skip += body.results.length;
          if (body.results.length < limit || (typeof body.total === "number" && skip >= body.total)) {
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "warn",
            event: "pendle-sources-budget-exhausted",
            message: "Pendle sources budget exhausted; keeping partial results",
            metadata: { resultCount: results.length },
          });
          degraded = true;
          break;
        }
        logWorkerEvent({
          scope: "lib",
          job: "sync-yield-data",
          level: "warn",
          event: "pendle-chain-failed",
          message: "Pendle chain source failed",
          metadata: { chainId },
          error,
        });
        degraded = true;
      }
    }
    return { candidates: results, degraded };
  } finally {
    budget.cleanup();
  }
}

export async function fetchYearnKongSources(signal?: AbortSignal): Promise<SupplementalFamilyFetchResult> {
  const results: ResolvedYieldCandidate[] = [];
  const budget = createOptionalSourceBudget("Yearn Kong sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  let degraded = false;

  try {
    for (const chainId of [1, 10, 137, 8453, 42161]) {
      const seenAddresses = new Set<string>();
      if (budget.budgetController.signal.aborted) break;
      try {
        const result = await fetchJsonWithRetry<{ data?: { vaults?: KongVault[] } }>(
          "https://kong.yearn.fi/api/gql",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({
              query: `query($chainId: Int!) {
  vaults(chainId: $chainId) {
    address name yearn
    asset { symbol address }
    tvl { close }
    apy { net blockTime }
    meta { category isRetired }
  }
}`,
              variables: { chainId },
            }),
            signal: budget.signal,
          },
          0,
          { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
        );
        if (!result?.response.ok) {
          degraded = true;
          continue;
        }
        const sourceFetchedAt = Math.floor(Date.now() / 1000);

        const body = result.body;
        const vaults = body.data?.vaults;
        if (!Array.isArray(vaults)) {
          degraded = true;
          continue;
        }

        for (const vault of vaults) {
          if (
            !isNonEmptyString(vault.address) ||
            !isNonEmptyString(vault.name) ||
            !isNonEmptyString(vault.asset?.symbol)
          ) {
            continue;
          }
          if (seenAddresses.has(vault.address.toLowerCase())) continue;
          if (vault.meta?.isRetired) continue;
          if (vault.meta?.category !== "Stablecoin") continue;

          const netApy = vault.apy?.net;
          if (typeof netApy !== "number" || !Number.isFinite(netApy) || netApy <= 0) continue;
          const blockTime = vault.apy?.blockTime;
          const blockSec = typeof blockTime === "string" && /^[0-9]+$/.test(blockTime) ? Number(blockTime) : NaN;
          const sourceObservedAt = Number.isSafeInteger(blockSec) && blockSec > 0 && blockSec <= sourceFetchedAt
            ? blockSec
            : null;

          const tvl = vault.tvl?.close;
          if (typeof tvl !== "number" || tvl < KONG_MIN_TVL_USD) continue;

          seenAddresses.add(vault.address.toLowerCase());
          const chain = normalizeChainId(chainId);
          if (!chain) continue;
          const normalizedAssetAddress = vault.asset.address?.toLowerCase() ?? null;
          const isK3Sbold =
            chain === "ethereum" &&
            normalizedAssetAddress === "0x9f4330700a36b29952869fac9b33f45eedd8a3d8" &&
            vault.name.trim().toLowerCase() === "staked ybold";
          const sourcePrefix = vault.yearn ? "Yearn" : "Kong";
          const sourceNamespace = isK3Sbold ? "k3" : vault.yearn ? "yearn" : "kong";

          results.push(buildSupplementalCandidate(
            {
              stablecoinId: isK3Sbold ? "sbold-k3-capital" : undefined,
              symbol: vault.asset.symbol, chain, address: vault.asset.address ?? null,
            },
            netApy * 100, vault.address, tvl,
            `protocol-api:${sourceNamespace}:${chain}:${vault.address.toLowerCase()}`,
            isK3Sbold ? "K3: sBOLD" : `${sourcePrefix}: ${vault.name}`,
            isK3Sbold ? "lending-vault" : "lending-opportunity", sourceFetchedAt, sourceObservedAt,
          ));
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "warn",
            event: "yearn-kong-sources-budget-exhausted",
            message: "Yearn Kong sources budget exhausted; keeping partial results",
            metadata: { resultCount: results.length },
          });
          degraded = true;
          break;
        }
        logWorkerEvent({
          scope: "lib",
          job: "sync-yield-data",
          level: "warn",
          event: "yearn-kong-chain-failed",
          message: "Yearn Kong chain source failed",
          metadata: { chainId },
          error,
        });
        degraded = true;
      }
    }
    return { candidates: results, degraded };
  } finally {
    budget.cleanup();
  }
}

export async function fetchBeefySources(signal?: AbortSignal): Promise<SupplementalFamilyFetchResult> {
  const budget = createOptionalSourceBudget("Beefy sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  try {
    const [apyRes, vaultsRes, tvlRes] = await Promise.all([
      fetchJsonWithRetry<Record<string, number | null>>(
        "https://api.beefy.finance/apy",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
      fetchJsonWithRetry<BeefyVault[]>(
        "https://api.beefy.finance/vaults",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
      fetchJsonWithRetry<BeefyTvlPayload>(
        "https://api.beefy.finance/tvl",
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
    ]);
    if (!apyRes?.response.ok || !vaultsRes?.response.ok || !tvlRes?.response.ok) {
      return { candidates: [], degraded: true };
    }
    const sourceFetchedAt = Math.floor(Date.now() / 1000);

    const apyMap = apyRes.body;
    const vaults = vaultsRes.body;
    const tvlMap = tvlRes.body;
    if (!Array.isArray(vaults)) return { candidates: [], degraded: true };
    // A different document shape here silently matches nothing, so treat it as
    // a parse failure rather than as "the provider has no eligible vaults".
    if (!isRecord(apyMap) || !isRecord(tvlMap)) return { candidates: [], degraded: true };

    const results: ResolvedYieldCandidate[] = [];
    for (const vault of vaults) {
      if (!vault || !isNonEmptyString(vault.id)) continue;
      if (vault.status !== "active") continue;
      if (!vault.assets || vault.assets.length !== 1 || !isNonEmptyString(vault.assets[0])) continue;
      const chain = resolveBeefyCanonicalChain(vault.chain);
      if (!chain) continue;
      if (!isNonEmptyString(vault.tokenAddress)) continue;

      const apy = apyMap[vault.id];
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > BEEFY_MAX_APY) continue;
      const tvl = resolveBeefyTvl(tvlMap, chain, vault.id);
      if (typeof tvl !== "number" || !Number.isFinite(tvl) || tvl < BEEFY_MIN_TVL_USD) continue;

      results.push(buildSupplementalCandidate(
        { symbol: vault.assets[0], chain, address: vault.tokenAddress },
        apy * 100, vault.id, tvl,
        `protocol-api:beefy:${chain}:${vault.id}`,
        `Beefy: ${vault.name || vault.id}`, "lending-opportunity", sourceFetchedAt,
      ));
    }
    return { candidates: results, degraded: false };
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      logWorkerEvent({
        scope: "lib",
        job: "sync-yield-data",
        level: "warn",
        event: "beefy-sources-budget-exhausted",
        message: "Beefy sources budget exhausted; continuing without this source family",
      });
      return { candidates: [], degraded: true };
    }
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "beefy-sources-failed",
      message: "Beefy sources failed",
      error,
    });
    return { candidates: [], degraded: true };
  } finally {
    budget.cleanup();
  }
}
