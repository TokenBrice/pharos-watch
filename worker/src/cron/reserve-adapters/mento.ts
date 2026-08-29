import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput, LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import {
  decodeMentoPoolExchange,
  MENTO_BIPOOL_MANAGER_ADDRESS,
  MENTO_GET_EXCHANGE_IDS_SELECTOR,
  MENTO_GET_POOL_EXCHANGE_SELECTOR,
  MENTO_POOL_SPREAD_FIXIDITY_SCALE,
  type MentoPoolExchange,
} from "@shared/lib/mento-contracts";
import type { AdapterContext, AdapterResult } from "./types";
import { toErrorMessage } from "@shared/lib/error-utils";
import { decodeBytes32ArrayWord } from "./abi-decode";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchErc20Balance,
  fetchErc20TotalSupply,
  fetchJsonWithRetry,
  fetchOnchainRateBps,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  fetchTextWithRetry,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromPercentages,
  slicesFromValues,
} from "./helpers";
import { buildBrowserHeaders, NEUTRAL_ADAPTER_HEADERS } from "./request";
import { requireJsonInput } from "./input-guards";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { throwIfAborted } from "../../lib/abort";

type MentoCdpStablecoin = "GBPm" | "JPYm" | "CHFm" | "XOFm";

interface MentoReserveEntry {
  symbol: string;
  percent: number;
}

interface MentoCdpTroveEntry {
  stablecoin: MentoCdpStablecoin;
  collateralToken: string;
  collateralUsd: number;
  debtUsd: number;
  ratio?: number;
}

interface MentoReserveApiAsset {
  symbol?: unknown;
  percentage?: unknown;
}

interface MentoCdpTroveApiEntry {
  stablecoin?: unknown;
  collateral_token?: unknown;
  collateral_usd?: unknown;
  debt_usd?: unknown;
  ratio?: unknown;
  status?: unknown;
}

interface MentoReserveApiResponse {
  collateral?: {
    assets?: MentoReserveApiAsset[];
  };
  cdp_troves?: {
    troves?: MentoCdpTroveApiEntry[];
  };
}

// The Mento dashboard ships its reserve payload as a React Query cache entry
// embedded in the Next.js Flight payload. The reserve-scoped timestamp appears
// near the historical `troves` array or the current `cdp_backings` array and the
// `dataUpdateCount` cache marker. Anchoring on those neighbours rules out the
// many unrelated `"timestamp":"..."` occurrences in the bundle.
const MENTO_DASHBOARD_PAYLOAD_KEYS = ["cdp_backings", "troves"] as const;
const MENTO_DASHBOARD_MAX_ESCAPE_DEPTH = 5;
const MENTO_DASHBOARD_PAYLOAD_WINDOW_CHARS = 64_000;
const MENTO_DASHBOARD_TIMESTAMP_IN_WINDOW_PATTERN =
  /\\{1,5}"timestamp\\{1,5}"\s*:\s*\\{1,5}"([^"\\]+)\\{1,5}"/;
const MENTO_DASHBOARD_DATA_UPDATE_COUNT_IN_WINDOW_PATTERN = /\\{1,5}"dataUpdateCount\\{1,5}"/;
const MENTO_DASHBOARD_DATA_UPDATED_AT_IN_WINDOW_PATTERN = /\\{1,5}"dataUpdatedAt\\{1,5}"\s*:\s*(\d{13,})/;

function hasEscapedQuoteAt(value: string, index: number): boolean {
  let slashCount = 0;
  while (
    slashCount < MENTO_DASHBOARD_MAX_ESCAPE_DEPTH &&
    value[index + slashCount] === "\\"
  ) {
    slashCount += 1;
  }

  return slashCount > 0 && value[index + slashCount] === "\"";
}

function findDashboardPayloadKeyIndex(html: string, key: string): number | null {
  let keyIndex = html.indexOf(key);
  while (keyIndex >= 0) {
    if (hasEscapedQuoteAt(html, keyIndex + key.length)) {
      return keyIndex;
    }
    keyIndex = html.indexOf(key, keyIndex + key.length);
  }

  return null;
}

function extractMentoDashboardPayloadWindow(html: string): string | null {
  for (const key of MENTO_DASHBOARD_PAYLOAD_KEYS) {
    const keyIndex = findDashboardPayloadKeyIndex(html, key);
    if (keyIndex != null) {
      return html.slice(
        keyIndex,
        Math.min(html.length, keyIndex + MENTO_DASHBOARD_PAYLOAD_WINDOW_CHARS),
      );
    }
  }

  return null;
}

interface TokenConfig {
  key: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  stableLike?: boolean;
}

const TOKEN_CONFIG: Record<string, TokenConfig> = {
  sUSDS: {
    key: "sUSDS",
    name: "sUSDS (Sky savings USDS)",
    risk: "low",
    coinId: "susds-sky",
    stableLike: true,
  },
  EURC: {
    key: "EURC",
    name: "EURC (Circle euro stablecoin)",
    risk: "low",
    coinId: "eurc-circle",
    stableLike: true,
  },
  EUROP: {
    key: "EUROP",
    name: "EUROP (Schuman euro stablecoin)",
    risk: "low",
    coinId: "europ-schuman",
    stableLike: true,
  },
  axlEUROC: {
    key: "EURC",
    name: "EURC (Circle euro stablecoin)",
    risk: "low",
    coinId: "eurc-circle",
    stableLike: true,
  },
  CELO: { key: "CELO", name: "CELO", risk: getCanonicalReserveAssetRisk("CELO") ?? "high" },
  USDGLO: {
    key: "USDGLO",
    name: "USDGLO (Glo Dollar)",
    risk: "low",
    coinId: "usdglo-glo",
    stableLike: true,
  },
  stETH: {
    key: "stETH",
    name: "stETH (Lido staked ETH)",
    risk: getCanonicalReserveAssetRisk("stETH") ?? "low",
  },
  USDT: {
    key: "USDT",
    name: "USDT",
    risk: "low",
    coinId: "usdt-tether",
    stableLike: true,
  },
  USDT0: {
    key: "USDT",
    name: "USDT",
    risk: "low",
    coinId: "usdt-tether",
    stableLike: true,
  },
  USDC: {
    key: "USDC",
    name: "USDC",
    risk: "low",
    coinId: "usdc-circle",
    stableLike: true,
  },
  axlUSDC: {
    key: "USDC",
    name: "USDC",
    risk: "low",
    coinId: "usdc-circle",
    stableLike: true,
  },
  AUSD: {
    key: "AUSD",
    name: "AUSD (Agora Dollar)",
    risk: getCanonicalReserveAssetRisk("AUSD") ?? "low",
    coinId: "ausd-agora",
    stableLike: true,
  },
  ETH: { key: "ETH", name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK },
  WETH: { key: "ETH", name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK },
  WBTC: {
    key: "WBTC",
    name: "WBTC",
    risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium",
  },
  USDm: {
    key: "USDm",
    name: "USDm (Mento Dollar)",
    risk: "low",
    coinId: "cusd-celo",
    stableLike: true,
  },
};

// The Mento analytics API and dashboard intermittently return HTTP 404 to
// Cloudflare Worker egress while serving 200 to browser-like clients, so both
// fetches try browser-style headers first and fall back to the neutral
// Pharos fetch identity (mirrors the reservoir adapter's fallback shape).
const MENTO_BROWSER_HEADERS = buildBrowserHeaders("https://reserve.mento.org", "https://reserve.mento.org/");

async function fetchMentoWithBrowserFallback<T>(
  signal: AbortSignal,
  fetcher: (headers: HeadersInit) => Promise<T>,
): Promise<T> {
  try {
    return await fetcher(MENTO_BROWSER_HEADERS);
  } catch (primaryError) {
    if (signal.aborted) throw primaryError;
    try {
      return await fetcher(NEUTRAL_ADAPTER_HEADERS);
    } catch (fallbackError) {
      if (signal.aborted) throw fallbackError;
      throw new Error(
        `browser fetch failed: ${toErrorMessage(primaryError)}; neutral fetch failed: ${toErrorMessage(fallbackError)}`,
      );
    }
  }
}

const CDP_COLLATERAL_CONFIG: Record<string, TokenConfig & { depType: ReserveSlice["depType"] }> = {
  USDm: {
    key: "USDm",
    name: "USDm (Mento Dollar) CDP collateral",
    risk: "low",
    coinId: "cusd-celo",
    stableLike: true,
    depType: "collateral",
  },
};

function getCollateralAssets(payload: unknown): MentoReserveApiAsset[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("mento: layout-changed: response was not an object");
  }

  const response = payload as MentoReserveApiResponse;
  const assets = response.collateral?.assets;
  if (!Array.isArray(assets)) {
    throw new Error("mento: layout-changed: missing collateral.assets");
  }

  return assets;
}

export function parseMentoReserveComposition(payload: unknown): MentoReserveEntry[] {
  const assets = getCollateralAssets(payload);
  const entries = assets.flatMap((asset) => (
    typeof asset.symbol === "string" && typeof asset.percentage === "number"
      ? [{ symbol: asset.symbol, percent: asset.percentage }]
      : []
  ));

  if (entries.length === 0) {
    throw new Error("mento: layout-changed: collateral.assets contained no usable entries");
  }

  return entries;
}

function getCdpTroves(payload: unknown): MentoCdpTroveApiEntry[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("mento: layout-changed: response was not an object");
  }

  const response = payload as MentoReserveApiResponse;
  const troves = response.cdp_troves?.troves;
  if (!Array.isArray(troves)) {
    throw new Error("mento: layout-changed: missing cdp_troves.troves");
  }

  return troves;
}

function parseFiniteUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

export function parseMentoCdpComposition(payload: unknown, cdpStablecoin: MentoCdpStablecoin): MentoCdpTroveEntry[] {
  const troves = getCdpTroves(payload);
  const entries = troves.flatMap((trove) => {
    if (trove.stablecoin !== cdpStablecoin || trove.status !== "active" || typeof trove.collateral_token !== "string") {
      return [];
    }

    const collateralUsd = parseFiniteUsd(trove.collateral_usd);
    const debtUsd = parseFiniteUsd(trove.debt_usd);
    if (collateralUsd == null || collateralUsd <= 0 || debtUsd == null) {
      return [];
    }

    return [{
      stablecoin: cdpStablecoin,
      collateralToken: trove.collateral_token,
      collateralUsd,
      debtUsd,
      ...(typeof trove.ratio === "number" && Number.isFinite(trove.ratio) ? { ratio: trove.ratio } : {}),
    }];
  });

  if (entries.length === 0) {
    throw new Error(`mento: layout-changed: cdp_troves.troves contained no active ${cdpStablecoin} entries`);
  }

  return entries;
}

export function extractMentoDashboardTimestamp(html: string): number | null {
  const payloadWindow = extractMentoDashboardPayloadWindow(html);
  if (!payloadWindow) return null;

  const timestamp = payloadWindow.match(MENTO_DASHBOARD_TIMESTAMP_IN_WINDOW_PATTERN)?.[1];
  const parsedTimestamp = parseTimestampLikeToUnixSeconds(timestamp);
  if (parsedTimestamp != null && MENTO_DASHBOARD_DATA_UPDATE_COUNT_IN_WINDOW_PATTERN.test(payloadWindow)) {
    return parsedTimestamp;
  }

  const dataUpdatedAt = payloadWindow.match(MENTO_DASHBOARD_DATA_UPDATED_AT_IN_WINDOW_PATTERN)?.[1];
  return parseTimestampLikeToUnixSeconds(dataUpdatedAt);
}

export function adaptMentoReserveComposition(payload: unknown, sourceTimestamp: number | null = null): AdapterResult {
  const entries = parseMentoReserveComposition(payload);
  const warnings: LiveReserveWarning[] = [];

  if (entries.length < 3) {
    warnings.push(reserveInfoWarning(
      "mento-low-entry-count",
      `Mento reserve composition has only ${entries.length} entries (expected >= 3)`,
    ));
  }

  const grouped = new Map<string, {
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    pct: number;
    stableLike: boolean;
  }>();

  let stablePct = 0;
  for (const entry of entries) {
    const config = TOKEN_CONFIG[entry.symbol];
    if (!config) {
      warnings.push(reserveDegradedWarning("unknown-asset", `Unmapped Mento reserve symbol: ${entry.symbol}`));
      const existing = grouped.get(entry.symbol);
      if (existing) {
        existing.pct += entry.percent;
      } else {
        grouped.set(entry.symbol, {
          name: entry.symbol,
          risk: "medium",
          pct: entry.percent,
          stableLike: false,
        });
      }
      continue;
    }

    const existing = grouped.get(config.key);
    if (existing) {
      existing.pct += entry.percent;
    } else {
      grouped.set(config.key, {
        name: config.name,
        risk: config.risk,
        coinId: config.coinId,
        pct: entry.percent,
        stableLike: config.stableLike ?? false,
      });
    }

    if (config.stableLike) {
      stablePct += entry.percent;
    }
  }

  const totalPct = entries.reduce((sum, entry) => sum + entry.percent, 0);
  const slices = slicesFromPercentages(
    Array.from(grouped.values(), (group) => ({
      name: group.name,
      pct: group.pct,
      risk: group.risk,
      ...(group.coinId ? { coinId: group.coinId } : {}),
    })),
    { decimals: 1, context: "Mento reserve composition" },
  );

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      entryCount: entries.length,
      totalPct,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "mento-analytics-api",
        "Mento analytics API exposes reserve composition but not a trustworthy payload update timestamp",
      ),
      stableReservePct: stablePct,
    },
  };
}

export function adaptMentoCdpComposition(
  payload: unknown,
  cdpStablecoin: MentoCdpStablecoin,
  sourceTimestamp: number | null = null,
): AdapterResult {
  const entries = parseMentoCdpComposition(payload, cdpStablecoin);
  const warnings: LiveReserveWarning[] = [];

  const grouped = new Map<string, {
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
    value: number;
  }>();

  for (const entry of entries) {
    const config = CDP_COLLATERAL_CONFIG[entry.collateralToken];
    if (!config) {
      warnings.push(reserveDegradedWarning(
        "unknown-cdp-collateral",
        `Unmapped Mento CDP collateral token for ${cdpStablecoin}: ${entry.collateralToken}`,
      ));
    }

    const key = config?.key ?? entry.collateralToken;
    const existing = grouped.get(key);
    if (existing) {
      existing.value += entry.collateralUsd;
    } else {
      grouped.set(key, {
        name: config?.name ?? entry.collateralToken,
        risk: config?.risk ?? "medium",
        ...(config?.coinId ? { coinId: config.coinId } : {}),
        ...(config?.depType ? { depType: config.depType } : {}),
        value: entry.collateralUsd,
      });
    }
  }

  const totalCollateralUsd = entries.reduce((sum, entry) => sum + entry.collateralUsd, 0);
  const totalDebtUsd = entries.reduce((sum, entry) => sum + entry.debtUsd, 0);
  const collateralizationRatio = totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : undefined;

  return {
    slices: slicesFromValues(
      Array.from(grouped.values(), (group) => ({
        name: group.name,
        value: group.value,
        risk: group.risk,
        ...(group.coinId ? { coinId: group.coinId } : {}),
        ...(group.depType ? { depType: group.depType } : {}),
      })),
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      cdpStablecoin,
      cdpActiveTroves: entries.length,
      totalCollateralUsd,
      totalDebtUsd,
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "mento-analytics-api",
        "Mento analytics API exposes CDP collateral and debt but not a trustworthy payload update timestamp",
      ),
    },
  };
}

async function fetchMentoDashboardTimestamp(
  config: LiveReservesConfig,
  signal: AbortSignal,
  warnings: LiveReserveWarning[],
  ctx?: AdapterContext,
): Promise<number | null> {
  const url = config.display?.url;
  if (!url) return null;
  try {
    const html = await fetchMentoWithBrowserFallback(
      signal,
      (headers) => fetchTextWithRetry(url, signal, 12_000, ctx, { headers }),
    );
    return extractMentoDashboardTimestamp(html);
  } catch (error) {
    warnings.push(reserveInfoWarning(
      "mento-dashboard-timestamp-failed",
      `Mento dashboard timestamp fetch failed (${url}): ${toErrorMessage(error)}`,
    ));
    return null;
  }
}

// --- Redemption telemetry ---------------------------------------------------
//
// Independent per-coin on-chain reads on Celo (chain id 42220), run after the
// analytics-API reserve composition above. Three shapes, matching how each
// Mento family member actually redeems:
//   - broker-pool: coin trades against a stable/USDm counter asset in a Mento
//     V2 Broker/BiPoolManager pool (cUSD/USDm, cEUR/EURm, and the 8 local-FX
//     stables).
//   - liquity-v2-cr: a mento-protocol/bold (Liquity v2 fork) CDP branch
//     (GBPm).
//   - fpmm-pool: a Mento V3 FPMM pool that redeems into USDm (JPYm, CHFm).
// Any read failure fails closed: no redemption telemetry is emitted for that
// coin (a degraded warning is added instead) and the reserve composition
// computed above is returned unaffected.

type EvmOnchainInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

const CELO_CHAIN = "celo";
const CELO_ONCHAIN_INPUT: EvmOnchainInput = { kind: "onchain-evm", chain: CELO_CHAIN, rpcMode: "public-rpc" };

const MENTO_BROKER_POOL_MAX_EXCHANGE_IDS = 64;
const MENTO_REDEMPTION_TIMEOUT_MS = 8_000;

// mento-protocol/bold (GBPm) is a Liquity v2 fork sharing the ActivePool debt
// and redemption-rate selectors already verified in liquity-v2-branches.ts.
const LIQUITY_V2_DEBT_SELECTOR = "0x45507998"; // getBoldDebt()
// The Mento fork's TroveManager has no hasBeenShutDown(); it exposes
// shutdownTime() (0 = live, nonzero = branch shut down) - verified on-chain
// against 0xb38aEf2b... on 2026-07-09 (hasBeenShutDown reverts there).
const LIQUITY_V2_SHUTDOWN_SELECTOR = "0x58569081"; // shutdownTime()
const LIQUITY_V2_REDEMPTION_RATE_SELECTOR = "0xc52861f2"; // getRedemptionRateWithDecay()

// The Mento V3 FPMM pool charges `lpFee + protocolFee`, both stored directly in
// basis points on the pool's own BASIS_POINTS_DENOMINATOR = 10_000 scale and
// applied symmetrically in getAmountOut() for either swap direction. Verified
// against the FPMM implementation behind the JPYm/CHFm proxies on 2026-08-12.
const FPMM_LP_FEE_SELECTOR = "0x704ce43e"; // lpFee()
const FPMM_PROTOCOL_FEE_SELECTOR = "0xb0e21e8a"; // protocolFee()

interface MentoPoolCallOptions {
  signal: AbortSignal;
  ctx: AdapterContext | undefined;
  rpcUrl: string | undefined;
  fallbackRpcUrl: string | undefined;
  rpcMode: EvmOnchainInput["rpcMode"];
  chain: string;
}

function mentoPoolCacheKey(params: MentoBrokerPoolParams, resource: string): string {
  return [
    "mento-bipool:v2",
    params.rpcUrl ?? "",
    params.fallbackRpcUrl ?? "",
    resource,
  ].join(":");
}

function loadCachedMentoPoolRead<T>(
  cacheKey: string,
  callOptions: MentoPoolCallOptions,
  load: () => Promise<T>,
): Promise<T> {
  const cache = callOptions.ctx?.requestCache;
  const cached = cache?.get(cacheKey) as Promise<T> | undefined;
  if (cached) return cached;

  const request: Promise<T> = load().catch((error) => {
    // Each coin has its own redemption deadline. Do not let one coin's abort
    // leave a rejected promise that poisons every later Mento coin in the run.
    if (callOptions.signal.aborted && cache?.get(cacheKey) === request) {
      cache.delete(cacheKey);
    }
    throw error;
  });
  cache?.set(cacheKey, request);
  return request;
}

function loadMentoExchangeIds(
  params: MentoBrokerPoolParams,
  callOptions: MentoPoolCallOptions,
): Promise<`0x${string}`[]> {
  return loadCachedMentoPoolRead(
    mentoPoolCacheKey(params, "exchange-ids"),
    callOptions,
    async () => {
      const exchangeIdsRaw = await fetchOnchainRawCall({
        ...callOptions,
        contract: MENTO_BIPOOL_MANAGER_ADDRESS,
        data: MENTO_GET_EXCHANGE_IDS_SELECTOR,
      });
      const exchangeIds = decodeBytes32ArrayWord(exchangeIdsRaw, {
        maxItems: MENTO_BROKER_POOL_MAX_EXCHANGE_IDS,
      });
      if (!exchangeIds || exchangeIds.length === 0) {
        throw new Error("mento broker-pool: could not enumerate BiPoolManager exchange ids");
      }
      return exchangeIds;
    },
  );
}

function loadMentoPoolExchange(
  params: MentoBrokerPoolParams,
  exchangeId: `0x${string}`,
  callOptions: MentoPoolCallOptions,
): Promise<MentoPoolExchange | null> {
  return loadCachedMentoPoolRead(
    mentoPoolCacheKey(params, `exchange:${exchangeId}`),
    callOptions,
    async () => decodePoolExchange(await fetchOnchainRawCall({
      ...callOptions,
      contract: MENTO_BIPOOL_MANAGER_ADDRESS,
      data: `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${exchangeId.slice(2)}`,
    })),
  );
}

function decodePoolExchange(raw: string | null): MentoPoolExchange | null {
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  try {
    return decodeMentoPoolExchange(raw as `0x${string}`);
  } catch {
    return null;
  }
}

type MentoParams = LiveReserveAdapterParamsByKey["mento"];
type MentoRedemptionParams = NonNullable<MentoParams["redemption"]>;
type MentoBrokerPoolParams = Extract<MentoRedemptionParams, { kind: "broker-pool" }>;
type MentoLiquityV2CrParams = Extract<MentoRedemptionParams, { kind: "liquity-v2-cr" }>;
type MentoFpmmPoolParams = Extract<MentoRedemptionParams, { kind: "fpmm-pool" }>;

async function fetchMentoBrokerPoolRedemption(
  params: MentoBrokerPoolParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  const callOptions = {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: CELO_ONCHAIN_INPUT.rpcMode,
    chain: CELO_ONCHAIN_INPUT.chain,
  };

  const exchangeIds = await loadMentoExchangeIds(params, callOptions);
  const poolExchanges: MentoPoolExchange[] = [];
  const matchedPoolIndexes = new Set<number>();
  for (const exchangeId of exchangeIds) {
    throwIfAborted(signal);
    const poolExchange = await loadMentoPoolExchange(params, exchangeId, callOptions);
    if (!poolExchange) continue;

    let matchedExchange = false;
    for (const [index, poolConfig] of params.pools.entries()) {
      if (matchedPoolIndexes.has(index)) continue;
      const selfAddress = poolConfig.selfTokenAddress.toLowerCase();
      const counterAddress = poolConfig.counterAsset.address.toLowerCase();
      const asset0 = poolExchange.asset0.toLowerCase();
      const asset1 = poolExchange.asset1.toLowerCase();
      if (
        (asset0 === selfAddress && asset1 === counterAddress) ||
        (asset0 === counterAddress && asset1 === selfAddress)
      ) {
        matchedPoolIndexes.add(index);
        matchedExchange = true;
      }
    }
    if (matchedExchange) poolExchanges.push(poolExchange);
    if (matchedPoolIndexes.size === params.pools.length) break;
  }

  let capacityUsd = 0;
  let maxFeeBps: number | null = null;
  for (const poolConfig of params.pools) {
    const selfAddress = poolConfig.selfTokenAddress.toLowerCase();
    const counterAddress = poolConfig.counterAsset.address.toLowerCase();
    const match = poolExchanges.find((pool) => {
      const asset0 = pool.asset0.toLowerCase();
      const asset1 = pool.asset1.toLowerCase();
      return (
        (asset0 === selfAddress && asset1 === counterAddress) ||
        (asset0 === counterAddress && asset1 === selfAddress)
      );
    });
    if (!match) {
      throw new Error(
        `mento broker-pool: no matching BiPoolManager exchange for ${poolConfig.selfTokenAddress}/${poolConfig.counterAsset.address}`,
      );
    }
    // BiPoolManager tracks virtual bucket depths at 18-decimal precision
    // regardless of the counter asset's native token decimals (e.g.
    // USDC/USDT); the counter bucket is the sellable redemption capacity,
    // valued 1:1 USD since every configured counter asset is USD- or
    // USDm-pegged.
    const counterBucketRaw = match.asset0.toLowerCase() === counterAddress ? match.bucket0 : match.bucket1;
    capacityUsd += decimalNumberFromBigInt(counterBucketRaw, 18);
    const feeBps = Number((match.config.spread * 10_000n) / MENTO_POOL_SPREAD_FIXIDITY_SCALE);
    maxFeeBps = maxFeeBps == null ? feeBps : Math.max(maxFeeBps, feeBps);
  }

  if (capacityUsd <= 0) {
    throw new Error("mento broker-pool: matched pools returned zero counter-asset capacity");
  }

  return buildRedemptionSnapshotMetadata({
    capacityUsd,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatus: "open",
    routeStatusSource: "onchain",
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
    feeBps: maxFeeBps,
    ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
  });
}

async function fetchMentoLiquityV2CrRedemption(
  params: MentoLiquityV2CrParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  const callOptions = {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: CELO_ONCHAIN_INPUT.rpcMode,
    chain: CELO_ONCHAIN_INPUT.chain,
  };

  const [debtRaw, shutDownRaw, feeBps, totalSupplyRaw] = await Promise.all([
    fetchOnchainUint256({ ...callOptions, contract: params.activePoolAddress, data: LIQUITY_V2_DEBT_SELECTOR }),
    fetchOnchainRawCall({ ...callOptions, contract: params.troveManagerAddress, data: LIQUITY_V2_SHUTDOWN_SELECTOR }),
    fetchOnchainRateBps(
      CELO_ONCHAIN_INPUT,
      { contract: params.collateralRegistryAddress, selector: LIQUITY_V2_REDEMPTION_RATE_SELECTOR, decimals: 18 },
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
    fetchErc20TotalSupply(CELO_ONCHAIN_INPUT, params.tokenAddress, signal, ctx, params.rpcUrl, params.fallbackRpcUrl),
  ]);

  if (debtRaw == null || totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    throw new Error("mento liquity-v2-cr: could not read ActivePool debt or token total supply");
  }

  // shutdownTime() returns a uint256 timestamp: 0 while the branch is live,
  // nonzero once shut down. A null read keeps the honest "unknown" status.
  const shutdownTime = shutDownRaw != null && /^0x[0-9a-fA-F]{64}$/.test(shutDownRaw) ? BigInt(shutDownRaw) : null;
  const routeStatus = shutdownTime == null ? "unknown" : shutdownTime > 0n ? "degraded" : "open";
  const capacityRatioOfSupply = Math.min(
    1,
    decimalNumberFromBigInt(debtRaw, 18) / decimalNumberFromBigInt(totalSupplyRaw, 18),
  );

  return buildRedemptionSnapshotMetadata({
    capacityRatioOfSupply,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatus,
    routeStatusSource: "onchain",
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
    feeBps,
    ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
  });
}

async function fetchMentoFpmmPoolRedemption(
  params: MentoFpmmPoolParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  const callOptions = {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: CELO_ONCHAIN_INPUT.rpcMode,
    chain: CELO_ONCHAIN_INPUT.chain,
  };

  const [balanceRaw, lpFeeRaw, protocolFeeRaw] = await Promise.all([
    fetchErc20Balance(
      CELO_ONCHAIN_INPUT,
      params.usdmTokenAddress,
      params.poolAddress,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
    fetchOnchainUint256({ ...callOptions, contract: params.poolAddress, data: FPMM_LP_FEE_SELECTOR }),
    fetchOnchainUint256({ ...callOptions, contract: params.poolAddress, data: FPMM_PROTOCOL_FEE_SELECTOR }),
  ]);
  if (balanceRaw == null) {
    throw new Error("mento fpmm-pool: could not read USDm pool balance");
  }
  const capacityUsd = decimalNumberFromBigInt(balanceRaw, 18);
  if (capacityUsd <= 0) {
    throw new Error("mento fpmm-pool: USDm pool balance returned zero capacity");
  }

  // A missing fee leg keeps the capacity but emits no bound, so a partial read
  // can never understate the swap cost.
  const feeBps = lpFeeRaw != null && protocolFeeRaw != null ? Number(lpFeeRaw + protocolFeeRaw) : null;

  return buildRedemptionSnapshotMetadata({
    capacityUsd,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatus: "open",
    routeStatusSource: "onchain",
    holderEligibility: "any-holder",
    settlementDelaySec: 0,
    feeBps,
    ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
  });
}

function fetchMentoRedemptionMetadata(
  redemption: MentoRedemptionParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<NonNullable<AdapterResult["metadata"]>> {
  switch (redemption.kind) {
    case "broker-pool":
      return fetchMentoBrokerPoolRedemption(redemption, signal, ctx);
    case "liquity-v2-cr":
      return fetchMentoLiquityV2CrRedemption(redemption, signal, ctx);
    case "fpmm-pool":
      return fetchMentoFpmmPoolRedemption(redemption, signal, ctx);
  }
}

export async function fetchMentoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "mento");
  const dashboardWarnings: LiveReserveWarning[] = [];
  const [payload, sourceTimestamp] = await Promise.all([
    fetchMentoWithBrowserFallback(
      signal,
      (headers) => fetchJsonWithRetry<MentoReserveApiResponse>(input.url, signal, 12_000, ctx, { headers }),
    ),
    fetchMentoDashboardTimestamp(config, signal, dashboardWarnings, ctx),
  ]);
  const params = parseLiveReserveAdapterParams("mento", config.params);
  const result = params.cdpStablecoin
    ? adaptMentoCdpComposition(payload, params.cdpStablecoin, sourceTimestamp)
    : adaptMentoReserveComposition(payload, sourceTimestamp);
  const warnings = [...(result.warnings ?? []), ...dashboardWarnings];

  if (!params.redemption) {
    return warnings.length > 0 ? { ...result, warnings } : result;
  }

  try {
    const redemptionTimeout = createTimeoutSignal({
      timeoutMs: MENTO_REDEMPTION_TIMEOUT_MS,
      timeoutReason: new Error("mento-redemption-timeout"),
      parentSignal: signal,
    });
    let redemptionMetadata: NonNullable<AdapterResult["metadata"]>;
    try {
      redemptionMetadata = await fetchMentoRedemptionMetadata(params.redemption, redemptionTimeout.signal, ctx);
    } finally {
      redemptionTimeout.dispose();
    }
    return {
      ...result,
      ...(warnings.length > 0 ? { warnings } : {}),
      metadata: { ...result.metadata, ...redemptionMetadata },
    };
  } catch (error) {
    warnings.push(reserveDegradedWarning(
      "mento-redemption-telemetry-failed",
      `Mento redemption telemetry read failed: ${toErrorMessage(error)}`,
    ));
    return { ...result, warnings };
  }
}
