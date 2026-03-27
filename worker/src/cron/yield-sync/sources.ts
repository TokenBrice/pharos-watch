import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import {
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../../lib/constants";
import { getCache } from "../../lib/db-cache";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEvmUint256AtBlock,
} from "../../lib/evm-rpc";
import { fetchWithRetry } from "../../lib/fetch-retry";
import type { YieldBenchmarkMeta, YieldSourceInputMeta } from "@shared/types/yield";
import { ON_CHAIN_RATE_CONFIGS } from "../yield-config";
import { buildOnChainSourceKey, computeApyFromPrice } from "../yield-helpers";
import {
  parseDlStablecoinPoolsCache,
  parseRiskFreeRateCache,
  parseRiskFreeRatesCache,
} from "./cache";
import {
  buildHardcodedUsdBenchmark,
  type ParsedYieldBenchmarkRegistry,
} from "./benchmarks";
import { isYieldRelevantDlPool } from "./pool-filter";
import type { DlPool, ResolvedYield, ResolvedYieldCandidate } from "./types";

const DL_YIELDS_URL = "https://yields.llama.fi/pools";
const LIQUITY_V1_LUSD_ID = "lusd-liquity";
const BPROTOCOL_LQTY_ONLY_SOURCE_LABEL = "B.Protocol Stability Pool (LQTY only)";
const BPROTOCOL_LQTY_ONLY_SOURCE_TYPE = "lending-vault";
const LIQUITY_STABILITY_POOL_TOTAL_LQTY_REWARD = 32_000_000;
const LIQUITY_DAILY_LQTY_ISSUANCE_FACTOR = 1 - Math.pow(0.5, 1 / 365);
const LIQUITY_COMMUNITY_ISSUANCE = "0xD8c9D9071123a059C6E0A945cF0e0c82b508d816";
const LIQUITY_STABILITY_POOL = "0x66017D22b0f8556afDd19FC67041899Eb65a21bb";
const LIQUITY_TOTAL_LQTY_ISSUED_SELECTOR = "0xb140384b";
const LIQUITY_TOTAL_LUSD_DEPOSITS_SELECTOR = "0x9bf2f1ac";
const LIQUITY_LQTY_GECKO_ID = "liquity";
const BIMA_SUSBD_SOURCE_KEY = "protocol-api:bima-susbd";
const BIMA_SUSBD_SOURCE_LABEL = "BIMA savings (sUSBD)";
const BIMA_SUSBD_SOURCE_TYPE = "lending-vault";
const BIMA_EARN_POOLS_URL =
  "https://bima.money/api/earn/pools?network=Ethereum&user=0x0000000000000000000000000000000000000000";
const BIMA_MIN_TVL_USD = 100_000;
const BIMA_MIN_APY_PERCENT = 0.01;
const HASHNOTE_USYC_SOURCE_KEY = "protocol-api:hashnote-usyc";
const HASHNOTE_USYC_SOURCE_LABEL = "Hashnote USYC";
const HASHNOTE_USYC_SOURCE_TYPE = "nav-appreciation";
const HASHNOTE_PRICE_REPORTS_URL = "https://usyc.hashnote.com/api/price-reports";
const HASHNOTE_TARGET_LOOKBACK_SEC = 7 * DAY_SECONDS;
const HASHNOTE_MIN_LOOKBACK_SEC = 5 * DAY_SECONDS;
const HASHNOTE_MAX_FRESHNESS_SEC = 3 * DAY_SECONDS;

const MAX_DL_CACHE_AGE_SEC = 6 * 3600; // 6 hours (3× the expected 2-hour DEX sync refresh)
const OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS = 8_000;
const OPTIONAL_PROTOCOL_API_BUDGET_MS = 25_000;
const OPTIONAL_PROTOCOL_RPC_BUDGET_MS = 30_000;
const OPTIONAL_PROTOCOL_RPC_REQUEST_TIMEOUT_MS = 10_000;
const OPTIONAL_PROTOCOL_RPC_MAX_RETRIES = 2;
const ON_CHAIN_RATE_REQUEST_TIMEOUT_MS = 6_000;

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

function createOptionalSourceBudget(
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): { signal: AbortSignal; budgetController: AbortController; cleanup: () => void } {
  const budgetController = new AbortController();
  const timer = setTimeout(() => {
    budgetController.abort(new Error(`${label} budget exhausted after ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);

  return {
    signal: signal ? AbortSignal.any([signal, budgetController.signal]) : budgetController.signal,
    budgetController,
    cleanup: () => clearTimeout(timer),
  };
}

function resolveCanonicalChain(chain: string | number | null | undefined): string | null {
  if (typeof chain === "number") {
    for (const [chainId, meta] of Object.entries(CHAIN_META)) {
      if (meta.evmChainId === chain) {
        return chainId;
      }
    }
    return null;
  }

  if (typeof chain === "string" && chain.length > 0) {
    return resolveChainId(chain) ?? chain.toLowerCase();
  }

  return null;
}

export interface OptionalRpcFamilyTelemetry {
  targetCount: number;
  attemptedCount: number;
  resolvedTargetCount: number;
  emittedCount: number;
  missingTargetCount: number;
  missingByChain: Record<string, number>;
  missingReasonCounts: Record<string, number>;
  missingTargets: string[];
  budgetExhausted: boolean;
  endpointStrategy: "alternating-fallback-primary";
}

function createOptionalRpcFamilyTelemetry(targetCount: number): OptionalRpcFamilyTelemetry {
  return {
    targetCount,
    attemptedCount: 0,
    resolvedTargetCount: 0,
    emittedCount: 0,
    missingTargetCount: 0,
    missingByChain: {},
    missingReasonCounts: {},
    missingTargets: [],
    budgetExhausted: false,
    endpointStrategy: "alternating-fallback-primary",
  };
}

function buildOptionalRpcTargetLabel(chain: string, symbol: string): string {
  return `${chain}:${symbol}`;
}

function recordOptionalRpcMiss(
  telemetry: OptionalRpcFamilyTelemetry,
  chain: string,
  targetLabel: string,
  reason: string,
): void {
  telemetry.missingTargetCount += 1;
  telemetry.missingByChain[chain] = (telemetry.missingByChain[chain] ?? 0) + 1;
  telemetry.missingReasonCounts[reason] = (telemetry.missingReasonCounts[reason] ?? 0) + 1;
  telemetry.missingTargets.push(targetLabel);
}

function buildOptionalRpcUrls(rpc: ChainRpcConfig | undefined, rotationSeed = 0): string[] {
  if (!rpc) {
    return [];
  }

  const primary = typeof rpc.rpcUrl === "string" && rpc.rpcUrl.length > 0 ? rpc.rpcUrl : null;
  const fallback =
    typeof rpc.fallbackRpcUrl === "string" && rpc.fallbackRpcUrl.length > 0 ? rpc.fallbackRpcUrl : null;

  const ordered = rotationSeed % 2 === 0
    ? [fallback, primary]
    : [primary, fallback];

  return Array.from(new Set(ordered.filter((url): url is string => typeof url === "string" && url.length > 0)));
}

function logOptionalRpcTelemetry(
  family: string,
  telemetry: OptionalRpcFamilyTelemetry,
): void {
  const reasonSummary = Object.entries(telemetry.missingReasonCounts)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");

  if (telemetry.missingTargetCount > 0 || telemetry.budgetExhausted) {
    console.warn(
      `[yield/${family}] resolved ${telemetry.resolvedTargetCount}/${telemetry.targetCount} targets `
      + `(emitted ${telemetry.emittedCount}, attempted ${telemetry.attemptedCount}; ${reasonSummary || "no-miss-reasons"})`,
    );
    return;
  }

  console.log(
    `[yield/${family}] resolved ${telemetry.resolvedTargetCount}/${telemetry.targetCount} targets `
    + `(emitted ${telemetry.emittedCount}, attempted ${telemetry.attemptedCount})`,
  );
}

export async function loadDlStablecoinPools(
  db: D1Database,
  signal?: AbortSignal,
): Promise<{ pools: DlPool[]; meta: YieldSourceInputMeta }> {
  const nowSec = Math.floor(Date.now() / 1000);
  let dlPools: DlPool[] = [];
  let fallbackMode: string | null = null;
  const cachedPools = await getCache(db, "dl-stablecoin-pools");
  if (cachedPools) {
    const parsed = parseDlStablecoinPoolsCache(cachedPools.value, cachedPools.updatedAt, nowSec);
    if (parsed) {
      const cacheAgeSec = parsed.meta.ageSeconds ?? 0;
      if (cacheAgeSec > MAX_DL_CACHE_AGE_SEC) {
        console.warn(
          `[sync-yield-data] DL pools cache too old (${Math.round(cacheAgeSec / 3600)}h), falling through to direct fetch`,
        );
        fallbackMode = "cache-too-old";
      } else {
        dlPools = parsed.pools;
        console.log(`[sync-yield-data] Using ${dlPools.length} cached stablecoin pools from DEX sync`);
        return parsed;
      }
    } else {
      console.warn("[sync-yield-data] Failed to parse cached DL pools, falling back to direct fetch");
      fallbackMode = "cache-parse-failed";
    }
  }

  if (dlPools.length === 0 && (await shouldAttemptFetch(db, CIRCUIT_SOURCE.DL_YIELDS))) {
    try {
      const res = await fetchWithRetry(DL_YIELDS_URL, {
        headers: { "User-Agent": USER_AGENT },
        signal,
      });
      if (res?.ok) {
        const body = (await res.json()) as { data?: unknown };
        if (!Array.isArray(body.data)) {
          console.warn("[sync-yield-data] DL yields direct fetch returned invalid payload shape");
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
          fallbackMode = "direct-fetch-invalid-payload";
          return {
            pools: [],
            meta: {
              mode: "unavailable",
              updatedAt: cachedPools?.updatedAt ?? null,
              ageSeconds: cachedPools ? Math.max(0, nowSec - cachedPools.updatedAt) : null,
              poolCount: 0,
              fallbackMode,
            },
          };
        }
        dlPools = (body.data as DlPool[]).filter(isYieldRelevantDlPool);
        if (dlPools.length === 0) {
          console.warn("[sync-yield-data] DL yields direct fetch returned no relevant stablecoin pools");
          await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
          fallbackMode = "direct-fetch-empty";
          return {
            pools: [],
            meta: {
              mode: "unavailable",
              updatedAt: cachedPools?.updatedAt ?? null,
              ageSeconds: cachedPools ? Math.max(0, nowSec - cachedPools.updatedAt) : null,
              poolCount: 0,
              fallbackMode,
            },
          };
        }
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, true);
        return {
          pools: dlPools,
          meta: {
            mode: "direct-fetch",
            updatedAt: nowSec,
            ageSeconds: 0,
            poolCount: dlPools.length,
            fallbackMode,
          },
        };
      } else {
        await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
        fallbackMode = "direct-fetch-failed";
      }
    } catch (error) {
      console.warn("[sync-yield-data] DL yields direct fetch failed:", error);
      await recordOutcome(db, CIRCUIT_SOURCE.DL_YIELDS, false);
      fallbackMode = "direct-fetch-exception";
    }
  } else if (dlPools.length === 0) {
    fallbackMode = "circuit-open";
  }

  return {
    pools: dlPools,
    meta: {
      mode: "unavailable",
      updatedAt: cachedPools?.updatedAt ?? null,
      ageSeconds: cachedPools ? Math.max(0, nowSec - cachedPools.updatedAt) : null,
      poolCount: dlPools.length,
      fallbackMode,
    },
  };
}

export interface OnChainRateResult {
  rates: Map<string, { rate: number }>;
  failureBreakdown: Record<string, number> | null;
  attemptedCount?: number;
  allDeterministicFailed?: boolean;
  explorerAttemptedCount?: number;
  explorerResolvedCount?: number;
}

type OnChainRateFailureStatus =
  | "no-rpc|etherscan-empty"
  | "no-rpc|etherscan-unavailable"
  | "rpc-empty|etherscan-empty"
  | "rpc-empty|etherscan-unavailable";

type OnChainRateFetchResult =
  | {
    id: string;
    rate: number;
    status: "ok";
    resolvedVia: "rpc" | "etherscan";
    explorerAttempted: boolean;
  }
  | { id: string; status: OnChainRateFailureStatus; explorerAttempted: boolean };

function buildOnChainFailureStatus(
  rpcStatus: "no-rpc" | "rpc-empty",
  etherscanStatus: "etherscan-empty" | "etherscan-unavailable",
): OnChainRateFailureStatus {
  return `${rpcStatus}|${etherscanStatus}` as OnChainRateFailureStatus;
}

function buildOnChainRateRpcUrls(rpc?: ChainRpcConfig): string[] {
  if (!rpc) {
    return [];
  }

  const urls = [
    rpc.fallbackRpcUrl,
    rpc.rpcUrl,
  ].filter((url): url is string => typeof url === "string" && url.length > 0);

  return Array.from(new Set(urls));
}

async function fetchSingleOnChainRate(
  config: (typeof ON_CHAIN_RATE_CONFIGS)[number],
  rpc: ChainRpcConfig | undefined,
  etherscanApiKey?: string | null,
  signal?: AbortSignal,
): Promise<OnChainRateFetchResult> {
  const callData = config.selector + config.inputAmount.replace("0x", "").padStart(64, "0");
  const rpcUrls = buildOnChainRateRpcUrls(rpc);
  const rpcStatus: "no-rpc" | "rpc-empty" = rpcUrls.length === 0 ? "no-rpc" : "rpc-empty";

  for (const rpcUrl of rpcUrls) {
    try {
      const raw = await fetchEvmUint256AtBlock(undefined, config.contract, callData, "latest", {
        extraRpcUrls: [rpcUrl],
        signal,
        timeoutMs: ON_CHAIN_RATE_REQUEST_TIMEOUT_MS,
      });
      if (raw == null) {
        continue;
      }
      return {
        id: config.stablecoinId,
        rate: Number(raw) / 10 ** config.decimals,
        status: "ok",
        resolvedVia: "rpc",
        explorerAttempted: false,
      };
    } catch (err) {
      if (signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  const evmChainId = CHAIN_META[config.chain]?.evmChainId;
  if (typeof evmChainId !== "number" || !etherscanApiKey) {
    return {
      id: config.stablecoinId,
      status: buildOnChainFailureStatus(rpcStatus, "etherscan-unavailable"),
      explorerAttempted: false,
    };
  }

  try {
    const raw = await fetchEtherscanUint256AtBlock(evmChainId, config.contract, callData, "latest", {
      apiKey: etherscanApiKey,
      signal,
      timeoutMs: ON_CHAIN_RATE_REQUEST_TIMEOUT_MS,
    });
    if (raw != null) {
      return {
        id: config.stablecoinId,
        rate: Number(raw) / 10 ** config.decimals,
        status: "ok",
        resolvedVia: "etherscan",
        explorerAttempted: true,
      };
    }
  } catch (err) {
    if (signal?.aborted) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    id: config.stablecoinId,
    status: buildOnChainFailureStatus(rpcStatus, "etherscan-empty"),
    explorerAttempted: true,
  };
}

export async function fetchOnChainRates(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  etherscanApiKey?: string | null,
): Promise<OnChainRateResult> {
  if (!chainRpcs) {
    console.warn("[yield] No chain RPCs configured, skipping all on-chain rate fetches");
    const attemptedCount = ON_CHAIN_RATE_CONFIGS.length;
    return {
      rates: new Map(),
      failureBreakdown: { "no-chain-rpcs": attemptedCount },
      attemptedCount,
      allDeterministicFailed: attemptedCount > 0,
    };
  }

  // Fetch vault exchange rates in smaller batches to avoid brief RPC bursts
  // that can collapse an otherwise healthy deterministic lane into all-null.
  const RATE_BATCH_SIZE = 1;
  const allResults: PromiseSettledResult<OnChainRateFetchResult>[] = [];
  for (let i = 0; i < ON_CHAIN_RATE_CONFIGS.length; i += RATE_BATCH_SIZE) {
    const batch = ON_CHAIN_RATE_CONFIGS.slice(i, i + RATE_BATCH_SIZE);
    const tasks = batch.map(async (config): Promise<OnChainRateFetchResult> => {
      const rpc = getChainRpc(chainRpcs, config.chain);
      return fetchSingleOnChainRate(config, rpc, etherscanApiKey, signal);
    });
    const batchSettled = await Promise.allSettled(tasks);
    allResults.push(...batchSettled);
  }

  const settled = allResults;
  const rates = new Map<string, { rate: number }>();
  const failureCounts: Record<string, number> = {};
  let explorerAttemptedCount = 0;
  let explorerResolvedCount = 0;

  for (const result of settled) {
    const val = result.status === "fulfilled" ? result.value : { id: "unknown", status: "rejected" as const };
    if ("rate" in val && val.status === "ok") {
      rates.set(val.id, { rate: val.rate });
      if (val.explorerAttempted) {
        explorerAttemptedCount += 1;
      }
      if (val.resolvedVia === "etherscan") {
        explorerResolvedCount += 1;
      }
    } else {
      if (result.status === "fulfilled" && result.value.explorerAttempted) {
        explorerAttemptedCount += 1;
      }
      failureCounts[val.status] = (failureCounts[val.status] ?? 0) + 1;
    }
  }

  const totalFailures = Object.values(failureCounts).reduce((s, n) => s + n, 0);
  if (totalFailures > 0) {
    const breakdown = Object.entries(failureCounts).map(([k, v]) => `${k}=${v}`).join(", ");
    console.warn(`[yield] On-chain rates: ${rates.size}/${ON_CHAIN_RATE_CONFIGS.length} ok (${breakdown})`);
  }

  const attemptedCount = ON_CHAIN_RATE_CONFIGS.length;
  return {
    rates,
    failureBreakdown: totalFailures > 0 ? failureCounts : null,
    attemptedCount,
    allDeterministicFailed: attemptedCount > 0 && rates.size === 0 && totalFailures >= attemptedCount,
    explorerAttemptedCount,
    explorerResolvedCount,
  };
}

async function fetchEthCallUint256(
  rpcUrl: string,
  chain: string,
  to: string,
  data: string,
  signal?: AbortSignal,
): Promise<bigint | null> {
  try {
    return await fetchEvmUint256AtBlock(chain, to, data, "latest", {
      extraRpcUrls: [rpcUrl],
      signal,
      timeoutMs: 10_000,
    });
  } catch (error) {
    console.warn(`[yield] eth_call failed for ${to} ${data}:`, error);
    return null;
  }
}

async function fetchCoinGeckoUsdPrice(
  geckoId: string,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
): Promise<number | null> {
  try {
    const res = await fetchWithRetry(
      cgUrl(`/simple/price?ids=${encodeURIComponent(geckoId)}&vs_currencies=usd`, coingeckoApiKey ?? null),
      {
        headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey ?? null),
        signal,
      },
      1,
    );
    if (!res?.ok) return null;

    const body = (await res.json()) as Record<string, { usd?: number }>;
    const price = body[geckoId]?.usd;
    return typeof price === "number" && price > 0 ? price : null;
  } catch (error) {
    console.warn(`[yield] CoinGecko price fetch failed for ${geckoId}:`, error);
    return null;
  }
}

export async function fetchBprotocolLqtyOnlySource(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  coingeckoApiKey?: string | null,
): Promise<ResolvedYield | null> {
  if (!chainRpcs) {
    console.warn("[yield] No chain RPCs provided for B.Protocol LQTY-only source");
    return null;
  }
  const rpc = getChainRpc(chainRpcs, "ethereum");
  if (!rpc) {
    console.warn("[yield] No Ethereum RPC configured for B.Protocol LQTY-only source");
    return null;
  }

  try {
    const lqtyPriceUsd = await fetchCoinGeckoUsdPrice(LIQUITY_LQTY_GECKO_ID, signal, coingeckoApiKey);
    if (lqtyPriceUsd == null) return null;

    let totalLusdDepositsRaw: bigint | null = null;
    let totalLqtyIssuedRaw: bigint | null = null;
    const rpcUrls = [rpc.rpcUrl, rpc.fallbackRpcUrl].filter(
      (url): url is string => typeof url === "string" && url.length > 0,
    );

    for (const rpcUrl of rpcUrls) {
      const [lusdDeposits, lqtyIssued] = await Promise.all([
        fetchEthCallUint256(rpcUrl, "ethereum", LIQUITY_STABILITY_POOL, LIQUITY_TOTAL_LUSD_DEPOSITS_SELECTOR, signal),
        fetchEthCallUint256(rpcUrl, "ethereum", LIQUITY_COMMUNITY_ISSUANCE, LIQUITY_TOTAL_LQTY_ISSUED_SELECTOR, signal),
      ]);
      if (lusdDeposits != null && lqtyIssued != null) {
        totalLusdDepositsRaw = lusdDeposits;
        totalLqtyIssuedRaw = lqtyIssued;
        break;
      }
    }

    if (totalLusdDepositsRaw == null || totalLqtyIssuedRaw == null) return null;

    const totalLusdDeposits = Number(totalLusdDepositsRaw) / 1e18;
    const totalLqtyIssued = Number(totalLqtyIssuedRaw) / 1e18;
    if (!Number.isFinite(totalLusdDeposits) || totalLusdDeposits <= 0) return null;
    if (!Number.isFinite(totalLqtyIssued) || totalLqtyIssued < 0) return null;

    const remainingLqtyRewards = Math.max(
      0,
      LIQUITY_STABILITY_POOL_TOTAL_LQTY_REWARD - totalLqtyIssued,
    );
    if (remainingLqtyRewards <= 0) return null;

    const apr =
      (remainingLqtyRewards * LIQUITY_DAILY_LQTY_ISSUANCE_FACTOR * lqtyPriceUsd * 365 * 100)
      / totalLusdDeposits;
    if (!Number.isFinite(apr) || apr <= 0) return null;

    return {
      currentApy: apr,
      apyBase: null,
      apyReward: apr,
      sourcePool: null,
      sourceTvlUsd: totalLusdDeposits,
      dataSource: "onchain",
      exchangeRate: null,
      sourceKey: buildOnChainSourceKey(LIQUITY_V1_LUSD_ID),
      yieldSource: BPROTOCOL_LQTY_ONLY_SOURCE_LABEL,
      yieldType: BPROTOCOL_LQTY_ONLY_SOURCE_TYPE,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    console.warn("[yield] B.Protocol LQTY-only source failed:", error);
    return null;
  }
}

export async function fetchBimaSusbdSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  try {
    const res = await fetchWithRetry(
      BIMA_EARN_POOLS_URL,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal,
      },
      0,
      { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
    );
    if (!res?.ok) return null;

    const body = (await res.json()) as { success?: boolean; data?: unknown };
    if (!body.success || !Array.isArray(body.data) || body.data.length === 0) return null;

    const pool = (body.data as BimaEarnPool[]).find((entry) => {
      const title = entry.token?.title?.toUpperCase();
      const label = entry.token?.label?.toUpperCase();
      return title === "USBD" || label === "USBD";
    });
    if (!pool) return null;

    const unboostedApr =
      typeof pool.unboostedAPR === "number" && Number.isFinite(pool.unboostedAPR)
        ? pool.unboostedAPR
        : null;
    const boostedApr =
      typeof pool.boostedAPR === "number" && Number.isFinite(pool.boostedAPR)
        ? pool.boostedAPR
        : null;
    const currentApy =
      unboostedApr != null && boostedApr != null
        ? Math.max(unboostedApr, boostedApr)
        : (unboostedApr ?? boostedApr);
    if (currentApy == null || currentApy < BIMA_MIN_APY_PERCENT) return null;

    const sourceTvlUsd =
      typeof pool.amountTVL === "number" && Number.isFinite(pool.amountTVL) && pool.amountTVL >= BIMA_MIN_TVL_USD
        ? pool.amountTVL
        : null;
    if (sourceTvlUsd == null) return null;

    return {
      currentApy,
      apyBase: unboostedApr ?? currentApy,
      apyReward:
        boostedApr != null && unboostedApr != null
          ? Math.max(0, boostedApr - unboostedApr)
          : null,
      sourcePool: typeof pool.id === "string" ? pool.id : null,
      sourceTvlUsd,
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

export async function fetchHashnoteUsycSource(signal?: AbortSignal): Promise<ResolvedYield | null> {
  try {
    const res = await fetchWithRetry(
      HASHNOTE_PRICE_REPORTS_URL,
      {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal,
      },
      0,
      { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
    );
    if (!res?.ok) return null;

    const body = (await res.json()) as { entity?: string; data?: HashnoteReport[] };
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

const ONDO_USDY_SOURCE_KEY = "protocol-api:ondo-usdy-oracle";
const ONDO_USDY_SOURCE_LABEL = "Ondo USDY Oracle";
const ONDO_USDY_SOURCE_TYPE = "nav-appreciation";
const ONDO_USDY_ORACLE = "0xa0219aa5b31e65bc920b5b6dfb8edf0988121de0";
const ONDO_GET_PRICE_SELECTOR = "0x98d5fdca";

export async function fetchOndoUsdyOracleSource(
  prevPriceBigint: bigint | null,
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

    const currentPriceFloat = Number(currentPrice) / 1e18;
    if (!Number.isFinite(currentPriceFloat) || currentPriceFloat <= 0) return null;

    if (!prevPriceBigint || prevPriceBigint === 0n || daysDelta < 1) {
      return {
        currentApy: 0, apyBase: null, apyReward: null,
        sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
        exchangeRate: currentPriceFloat, sourceKey: ONDO_USDY_SOURCE_KEY,
        yieldSource: ONDO_USDY_SOURCE_LABEL, yieldType: ONDO_USDY_SOURCE_TYPE,
        sourceObservedAt: Math.floor(Date.now() / 1000), comparisonAnchorObservedAt: null,
      };
    }

    const prevPriceFloat = Number(prevPriceBigint) / 1e18;
    const apy = (Math.pow(currentPriceFloat / prevPriceFloat, 365.25 / daysDelta) - 1) * 100;
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

const MORPHO_GQL_URL = "https://api.morpho.org/graphql";
const MORPHO_STABLECOIN_SYMBOLS = ["USDC", "USDT", "DAI", "USDS", "GHO", "FRAX", "PYUSD", "FRXUSD", "crvUSD", "DOLA", "LUSD"];
const MORPHO_STABLECOIN_QUERY = `query($symbols: [String!]!) {
  vaults(first: 100, where: { listed: true, assetSymbol_in: $symbols, totalAssetsUsd_gte: 100000 }) {
    items {
      address name
      asset { symbol address }
      chain { id }
      state { netApy totalAssetsUsd fee }
    }
  }
}`;

interface MorphoVaultItem {
  address: string; name: string;
  asset: { symbol: string; address?: string | null };
  chain: { id: number };
  state: { netApy: number; totalAssetsUsd: number | null; fee: number } | null;
}

export async function fetchMorphoVaultSources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const budget = createOptionalSourceBudget("Morpho vault sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  try {
    const res = await fetchWithRetry(MORPHO_GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ query: MORPHO_STABLECOIN_QUERY, variables: { symbols: MORPHO_STABLECOIN_SYMBOLS } }),
      signal: budget.signal,
    }, 0, { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS });
    if (!res?.ok) return [];

    const body = (await res.json()) as { data?: { vaults?: { items?: MorphoVaultItem[] } } };
    const items = body.data?.vaults?.items;
    if (!Array.isArray(items)) return [];

    const results: ResolvedYieldCandidate[] = [];
    for (const vault of items) {
      const apy = vault.state?.netApy;
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;

      const tvl = vault.state?.totalAssetsUsd;
      if (typeof tvl !== "number" || tvl < 100_000) continue;
      const chain = resolveCanonicalChain(vault.chain?.id);
      if (!chain) continue;

      results.push({
        symbol: vault.asset.symbol,
        chain,
        address: vault.asset.address ?? null,
        yield: {
          currentApy: apy * 100,
          apyBase: apy * 100,
          apyReward: null,
          sourcePool: vault.address,
          sourceTvlUsd: tvl,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: `protocol-api:morpho-vault:${chain}:${vault.address.toLowerCase()}`,
          yieldSource: `Morpho: ${vault.name}`,
          yieldType: "lending-opportunity",
          sourceObservedAt: Math.floor(Date.now() / 1000),
          comparisonAnchorObservedAt: null,
        },
      });
    }
    return results;
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      console.warn("[yield] Morpho vault sources budget exhausted; continuing without this source family");
      return [];
    }
    console.warn("[yield] Morpho vault sources failed:", error);
    return [];
  } finally {
    budget.cleanup();
  }
}

const PENDLE_MARKETS_BASE = "https://api-v2.pendle.finance/core/v1";
const PENDLE_CHAINS = [1, 42161, 8453];

interface PendleMarket {
  id: string; address: string; chainId: number;
  isActive: boolean; expiry: string;
  impliedApy: number; underlyingApy: number; aggregatedApy: number;
  underlyingAsset: { symbol: string; address: string };
  assetRepresentation: string;
  protocol: string;
  liquidity: { usd: number };
  categoryIds: string[];
}

export async function fetchPendleMarketSources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const results: ResolvedYieldCandidate[] = [];
  const budget = createOptionalSourceBudget("Pendle market sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);

  try {
    for (const chainId of PENDLE_CHAINS) {
      if (budget.budgetController.signal.aborted) break;
      try {
        let skip = 0;
        const limit = 100;
        while (!budget.budgetController.signal.aborted) {
          const url = `${PENDLE_MARKETS_BASE}/${chainId}/markets?limit=${limit}&skip=${skip}&is_active=true`;
          const res = await fetchWithRetry(url, {
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            signal: budget.signal,
          }, 0, { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS });
          if (!res?.ok) break;

          const body = (await res.json()) as { total?: number; results?: PendleMarket[] };
          if (!Array.isArray(body.results) || body.results.length === 0) break;

          for (const market of body.results) {
            if (!market.categoryIds?.includes("stables")) continue;
            if (!market.isActive) continue;

            const apy = market.impliedApy;
            if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0) continue;

            const tvl = market.liquidity?.usd;
            if (typeof tvl !== "number" || tvl < 100_000) continue;

            const chain = resolveCanonicalChain(market.chainId);
            if (!chain) continue;

            results.push({
              symbol: market.underlyingAsset.symbol,
              chain,
              address: market.underlyingAsset.address,
              yield: {
                currentApy: apy * 100,
                apyBase: apy * 100,
                apyReward: null,
                sourcePool: market.address,
                sourceTvlUsd: tvl,
                dataSource: "protocol-api",
                exchangeRate: null,
                sourceKey: `protocol-api:pendle:${chain}:${market.address.toLowerCase()}`,
                yieldSource: `Pendle: ${market.protocol} ${market.assetRepresentation}`,
                yieldType: "lending-opportunity",
                sourceObservedAt: Math.floor(Date.now() / 1000),
                comparisonAnchorObservedAt: null,
              },
            });
          }

          skip += body.results.length;
          if (body.results.length < limit || (typeof body.total === "number" && skip >= body.total)) {
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          console.warn(`[yield] Pendle sources budget exhausted; keeping ${results.length} partial results`);
          break;
        }
        console.warn(`[yield] Pendle chain ${chainId} failed:`, error);
      }
    }
    return results;
  } finally {
    budget.cleanup();
  }
}

const YEARN_KONG_GQL_URL = "https://kong.yearn.fi/api/gql";
const YEARN_KONG_CHAINS = [1, 10, 137, 8453, 42161];
const YEARN_KONG_VAULTS_QUERY = `query($chainId: Int!) {
  vaults(chainId: $chainId) {
    address name yearn
    asset { symbol address }
    tvl { close }
    apy { net monthlyNet }
    meta { category isRetired }
  }
}`;

interface KongVault {
  address: string; name: string; yearn: boolean;
  asset: { symbol: string; address?: string | null };
  tvl: { close: number } | null;
  apy: { net: number | null; monthlyNet: number | null } | null;
  meta: { category: string | null; isRetired: boolean | null } | null;
}

export async function fetchYearnKongSources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const results: ResolvedYieldCandidate[] = [];
  const seenAddresses = new Set<string>();
  const budget = createOptionalSourceBudget("Yearn Kong sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);

  try {
    for (const chainId of YEARN_KONG_CHAINS) {
      if (budget.budgetController.signal.aborted) break;
      try {
        const res = await fetchWithRetry(YEARN_KONG_GQL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
          body: JSON.stringify({ query: YEARN_KONG_VAULTS_QUERY, variables: { chainId } }),
          signal: budget.signal,
        }, 0, { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS });
        if (!res?.ok) continue;

        const body = (await res.json()) as { data?: { vaults?: KongVault[] } };
        const vaults = body.data?.vaults;
        if (!Array.isArray(vaults)) continue;

        for (const vault of vaults) {
          if (seenAddresses.has(vault.address.toLowerCase())) continue;
          if (vault.meta?.isRetired) continue;
          if (vault.meta?.category !== "Stablecoin") continue;

          const netApy = vault.apy?.monthlyNet ?? vault.apy?.net;
          if (typeof netApy !== "number" || !Number.isFinite(netApy) || netApy <= 0) continue;

          const tvl = vault.tvl?.close;
          if (typeof tvl !== "number" || tvl < 100_000) continue;

          seenAddresses.add(vault.address.toLowerCase());
          const sourcePrefix = vault.yearn ? "Yearn" : "Kong";
          const sourceNamespace = vault.yearn ? "yearn" : "kong";
          const chain = resolveCanonicalChain(chainId);
          if (!chain) continue;
          results.push({
            symbol: vault.asset.symbol,
            chain,
            address: vault.asset.address ?? null,
            yield: {
              currentApy: netApy * 100,
              apyBase: netApy * 100,
              apyReward: null,
              sourcePool: vault.address,
              sourceTvlUsd: tvl,
              dataSource: "protocol-api",
              exchangeRate: null,
              sourceKey: `protocol-api:${sourceNamespace}:${chain}:${vault.address.toLowerCase()}`,
              yieldSource: `${sourcePrefix}: ${vault.name}`,
              yieldType: "lending-opportunity",
              sourceObservedAt: Math.floor(Date.now() / 1000),
              comparisonAnchorObservedAt: null,
            },
          });
        }
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          console.warn(`[yield] Yearn Kong sources budget exhausted; keeping ${results.length} partial results`);
          break;
        }
        console.warn(`[yield] Yearn Kong chain ${chainId} failed:`, error);
      }
    }
    return results;
  } finally {
    budget.cleanup();
  }
}

const BEEFY_APY_URL = "https://api.beefy.finance/apy";
const BEEFY_VAULTS_URL = "https://api.beefy.finance/vaults";

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

export async function fetchBeefySources(
  signal?: AbortSignal,
): Promise<ResolvedYieldCandidate[]> {
  const budget = createOptionalSourceBudget("Beefy sources", OPTIONAL_PROTOCOL_API_BUDGET_MS, signal);
  try {
    const [apyRes, vaultsRes] = await Promise.all([
      fetchWithRetry(
        BEEFY_APY_URL,
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
      fetchWithRetry(
        BEEFY_VAULTS_URL,
        { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: budget.signal },
        0,
        { timeoutMs: OPTIONAL_PROTOCOL_REQUEST_TIMEOUT_MS },
      ),
    ]);
    if (!apyRes?.ok || !vaultsRes?.ok) return [];

    const apyMap = (await apyRes.json()) as Record<string, number | null>;
    const vaults = (await vaultsRes.json()) as BeefyVault[];
    if (!Array.isArray(vaults)) return [];

    const results: ResolvedYieldCandidate[] = [];
    for (const vault of vaults) {
      if (vault.status !== "active") continue;
      if (!vault.assets || vault.assets.length !== 1) continue;
      const chain = resolveCanonicalChain(vault.chain);
      if (!chain) continue;
      if (!vault.tokenAddress) continue;

      const apy = apyMap[vault.id];
      if (typeof apy !== "number" || !Number.isFinite(apy) || apy <= 0 || apy > 0.5) continue;

      results.push({
        symbol: vault.assets[0],
        chain,
        address: vault.tokenAddress,
        yield: {
          currentApy: apy * 100,
          apyBase: apy * 100,
          apyReward: null,
          sourcePool: vault.id,
          sourceTvlUsd: null,
          dataSource: "protocol-api",
          exchangeRate: null,
          sourceKey: `protocol-api:beefy:${chain}:${vault.id}`,
          yieldSource: `Beefy: ${vault.name || vault.id}`,
          yieldType: "lending-opportunity",
          sourceObservedAt: Math.floor(Date.now() / 1000),
          comparisonAnchorObservedAt: null,
        },
      });
    }
    return results;
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
    if (budget.budgetController.signal.aborted) {
      console.warn("[yield] Beefy sources budget exhausted; continuing without this source family");
      return [];
    }
    console.warn("[yield] Beefy sources failed:", error);
    return [];
  } finally {
    budget.cleanup();
  }
}

const COMPOUND_V3_GET_UTILIZATION = "0x7eb71131";
const COMPOUND_V3_GET_SUPPLY_RATE = "0xd955759d";
const SECONDS_PER_YEAR = 31_536_000;

export const COMPOUND_V3_COMETS = [
  { stablecoinId: "usdc-circle", chain: "ethereum", comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", symbol: "USDC" },
  { stablecoinId: "usdt-tether", chain: "ethereum", comet: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", symbol: "USDT" },
  { stablecoinId: "usdc-circle", chain: "base", comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F", symbol: "USDC" },
  { stablecoinId: "usdc-circle", chain: "arbitrum", comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", symbol: "USDC" },
] as const;

export interface CompoundV3SupplyRateResult {
  results: Array<{ stablecoinId: string; yield: ResolvedYield }>;
  telemetry: OptionalRpcFamilyTelemetry;
}

export async function fetchCompoundV3SupplyRates(
  targets: Array<{ stablecoinId: string; chain: string; comet: string; symbol: string }>,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<CompoundV3SupplyRateResult> {
  const results: Array<{ stablecoinId: string; yield: ResolvedYield }> = [];
  const telemetry = createOptionalRpcFamilyTelemetry(targets.length);
  const accountedTargets = new Set<string>();
  const budget = createOptionalSourceBudget("Compound V3 supply rates", OPTIONAL_PROTOCOL_RPC_BUDGET_MS, signal);
  try {
    for (const [index, target] of targets.entries()) {
      const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
      if (budget.budgetController.signal.aborted) {
        telemetry.budgetExhausted = true;
        break;
      }
      try {
        const rpc = getChainRpc(chainRpcs ?? new Map(), target.chain);
        const extraRpcUrls = buildOptionalRpcUrls(rpc, index);
        if (extraRpcUrls.length === 0) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "no-rpc-config");
          accountedTargets.add(targetLabel);
          continue;
        }

        telemetry.attemptedCount += 1;
        const opts = {
          extraRpcUrls,
          signal: budget.signal,
          timeoutMs: OPTIONAL_PROTOCOL_RPC_REQUEST_TIMEOUT_MS,
          maxRetries: OPTIONAL_PROTOCOL_RPC_MAX_RETRIES,
        };

        const utilization = await fetchEvmUint256AtBlock(
          target.chain, target.comet, COMPOUND_V3_GET_UTILIZATION, "latest", opts,
        );
        if (utilization == null) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "utilization-unavailable");
          accountedTargets.add(targetLabel);
          continue;
        }

        const supplyRateData = COMPOUND_V3_GET_SUPPLY_RATE + utilization.toString(16).padStart(64, "0");
        const perSecondRate = await fetchEvmUint256AtBlock(
          target.chain, target.comet, supplyRateData, "latest", opts,
        );
        if (perSecondRate == null || perSecondRate === 0n) {
          recordOptionalRpcMiss(
            telemetry,
            target.chain,
            targetLabel,
            perSecondRate === 0n ? "zero-supply-rate" : "supply-rate-unavailable",
          );
          accountedTargets.add(targetLabel);
          continue;
        }

        const ratePerSecond = Number(perSecondRate) / 1e18;
        const apy = (Math.pow(1 + ratePerSecond, SECONDS_PER_YEAR) - 1) * 100;
        if (!Number.isFinite(apy) || apy <= 0) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "non-positive-apy");
          accountedTargets.add(targetLabel);
          continue;
        }

        results.push({
          stablecoinId: target.stablecoinId,
          yield: {
            currentApy: apy, apyBase: apy, apyReward: null,
            sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: `protocol-api:compound-v3-supply:${target.chain}:${target.comet.toLowerCase()}`,
            yieldSource: `Compound V3 (${target.chain})`,
            yieldType: "lending-opportunity",
            sourceObservedAt: Math.floor(Date.now() / 1000),
            comparisonAnchorObservedAt: null,
          },
        });
        telemetry.resolvedTargetCount += 1;
        accountedTargets.add(targetLabel);
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          telemetry.budgetExhausted = true;
          console.warn(`[yield] Compound V3 budget exhausted; keeping ${results.length} partial results`);
          break;
        }
        console.warn(`[yield] Compound V3 ${target.chain}:${target.symbol} failed:`, error);
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "rpc-exception");
        accountedTargets.add(targetLabel);
      }
    }

    if (budget.budgetController.signal.aborted) {
      telemetry.budgetExhausted = true;
    }
    for (const target of targets) {
      const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
      if (!accountedTargets.has(targetLabel)) {
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "budget-exhausted");
        accountedTargets.add(targetLabel);
      }
    }

    telemetry.emittedCount = results.length;
    logOptionalRpcTelemetry("compound-v3", telemetry);
    return { results, telemetry };
  } finally {
    budget.cleanup();
  }
}

export async function getPriceDerivedApy(
  db: D1Database,
  stablecoinId: string,
): Promise<{
  apy: number;
  sourceObservedAt: number;
  comparisonAnchorObservedAt: number;
} | null> {
  const now = Math.floor(Date.now() / 1000);
  const minLookbackSec = 7 * DAY_SECONDS;
  const maxLookbackSec = 45 * DAY_SECONDS;

  const [recentRow, anchoredRow] = await Promise.all([
    db
      .prepare(
        "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
      )
      .bind(stablecoinId)
      .first<{ price: number; snapshot_date: number }>(),
    db
      .prepare(
        `SELECT price, snapshot_date
         FROM supply_history
         WHERE stablecoin_id = ?
           AND price IS NOT NULL
           AND snapshot_date BETWEEN ? AND ?
         ORDER BY snapshot_date ASC
         LIMIT 1`,
      )
      .bind(stablecoinId, now - maxLookbackSec, now - minLookbackSec)
      .first<{ price: number; snapshot_date: number }>(),
  ]);

  if (!recentRow?.price || !anchoredRow?.price || anchoredRow.price <= 0) return null;

  const lookbackDays = (recentRow.snapshot_date - anchoredRow.snapshot_date) / DAY_SECONDS;
  if (!Number.isFinite(lookbackDays) || lookbackDays < 7) return null;

  return {
    apy: computeApyFromPrice(recentRow.price, anchoredRow.price, lookbackDays),
    sourceObservedAt: recentRow.snapshot_date,
    comparisonAnchorObservedAt: anchoredRow.snapshot_date,
  };
}

// ---------------------------------------------------------------------------
// Aave V3 on-chain supply rate adapter
// ---------------------------------------------------------------------------

const AAVE_V3_POOL_ADDRESSES: Record<string, string> = {
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
};

// getReserveData(address asset) selector
const AAVE_GET_RESERVE_DATA_SELECTOR = "0x35ea6a75";

const RAY = 10n ** 27n;

function rayToApy(currentLiquidityRate: bigint): number {
  const ratePerSecond = Number(currentLiquidityRate) / Number(RAY) / 31536000;
  return (Math.pow(1 + ratePerSecond, 31536000) - 1) * 100;
}

export interface AaveV3RateTarget {
  stablecoinId: string;
  symbol: string;
  chain: string;
  assetAddress: string;
}

export interface AaveV3RateResult {
  rates: Map<string, { apy: number; chain: string }>;
  telemetry: OptionalRpcFamilyTelemetry;
}

export async function fetchAaveV3SupplyRates(
  targets: AaveV3RateTarget[],
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<AaveV3RateResult> {
  const rates = new Map<string, { apy: number; chain: string }>();
  const telemetry = createOptionalRpcFamilyTelemetry(targets.length);
  const accountedTargets = new Set<string>();
  const resolvedTargets = new Set<string>();

  if (!chainRpcs || targets.length === 0) {
    if (!chainRpcs && targets.length > 0) {
      for (const target of targets) {
        const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "no-chain-rpcs");
      }
    }
    telemetry.emittedCount = rates.size;
    logOptionalRpcTelemetry("aave-v3", telemetry);
    return { rates, telemetry };
  }

  const budget = createOptionalSourceBudget("Aave V3 supply rates", OPTIONAL_PROTOCOL_RPC_BUDGET_MS, signal);
  const AAVE_BATCH_SIZE = 2;

  try {
    for (let i = 0; i < targets.length; i += AAVE_BATCH_SIZE) {
      if (budget.budgetController.signal.aborted) {
        telemetry.budgetExhausted = true;
        break;
      }
      const batch = targets.slice(i, i + AAVE_BATCH_SIZE);
      await Promise.all(
        batch.map(async (target, batchIndex) => {
          const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
          if (budget.budgetController.signal.aborted) {
            telemetry.budgetExhausted = true;
            return;
          }
          const poolAddress = AAVE_V3_POOL_ADDRESSES[target.chain];
          if (!poolAddress) {
            recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "unsupported-pool-chain");
            accountedTargets.add(targetLabel);
            return;
          }

          const rpc = getChainRpc(chainRpcs, target.chain);
          const rpcUrls = buildOptionalRpcUrls(rpc, i + batchIndex);
          if (rpcUrls.length === 0) {
            recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "no-rpc-config");
            accountedTargets.add(targetLabel);
            return;
          }

          // Encode getReserveData(address) calldata: selector + padded address
          const callData =
            AAVE_GET_RESERVE_DATA_SELECTOR +
            target.assetAddress.replace("0x", "").toLowerCase().padStart(64, "0");

          try {
            telemetry.attemptedCount += 1;
            const hex = await fetchEvmCallHexAtBlock(target.chain, poolAddress, callData, "latest", {
              extraRpcUrls: rpcUrls,
              signal: budget.signal,
              timeoutMs: OPTIONAL_PROTOCOL_RPC_REQUEST_TIMEOUT_MS,
              maxRetries: OPTIONAL_PROTOCOL_RPC_MAX_RETRIES,
            });

            if (!hex || hex.length < 2) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "reserve-data-unavailable");
              accountedTargets.add(targetLabel);
              return;
            }

            // currentLiquidityRate is the 3rd uint256 in the struct (byte offset 64–128)
            // hex string after stripping "0x": chars 128–191 (0-indexed)
            const stripped = hex.slice(2); // remove "0x"
            if (stripped.length < 192) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "reserve-data-short");
              accountedTargets.add(targetLabel);
              return;
            }

            const liquidityRateHex = stripped.slice(128, 192);
            const currentLiquidityRate = BigInt("0x" + liquidityRateHex);
            const apy = rayToApy(currentLiquidityRate);

            if (!Number.isFinite(apy) || apy <= 0) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "non-positive-apy");
              accountedTargets.add(targetLabel);
              return;
            }

            // Keep the best APY per stablecoin (in case of multiple chains)
            const existing = rates.get(target.stablecoinId);
            if (!existing || apy > existing.apy) {
              rates.set(target.stablecoinId, { apy, chain: target.chain });
            }
            resolvedTargets.add(targetLabel);
            telemetry.resolvedTargetCount = resolvedTargets.size;
            accountedTargets.add(targetLabel);
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            if (budget.budgetController.signal.aborted) {
              telemetry.budgetExhausted = true;
              return;
            }
            console.warn(
              `[yield/aave-v3] Failed to fetch reserve data for ${target.symbol} on ${target.chain}:`,
              err instanceof Error ? err.message : String(err),
            );
            recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "rpc-exception");
            accountedTargets.add(targetLabel);
          }
        }),
      );
    }

    if (budget.budgetController.signal.aborted) {
      telemetry.budgetExhausted = true;
    }
    for (const target of targets) {
      const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
      if (!accountedTargets.has(targetLabel)) {
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "budget-exhausted");
        accountedTargets.add(targetLabel);
      }
    }

    telemetry.emittedCount = rates.size;
    logOptionalRpcTelemetry("aave-v3", telemetry);
    return { rates, telemetry };
  } finally {
    budget.cleanup();
  }
}

export async function loadRiskFreeRateRegistry(db: D1Database): Promise<ParsedYieldBenchmarkRegistry> {
  const registryCache = await getCache(db, "risk_free_rates");
  if (registryCache) {
    const parsed = parseRiskFreeRatesCache(registryCache.value, registryCache.updatedAt);
    if (parsed) {
      return parsed;
    }
  }

  const legacyUsdCache = await getCache(db, "risk_free_rate");
  if (legacyUsdCache) {
    const parsedUsd = parseRiskFreeRateCache(
      legacyUsdCache.value,
      legacyUsdCache.updatedAt,
      Math.floor(Date.now() / 1000),
      { key: "USD" },
    );
    if (parsedUsd) {
      return {
        USD: parsedUsd,
        EUR: null,
        CHF: null,
      };
    }
  }

  return {
    USD: buildHardcodedUsdBenchmark(
      registryCache || legacyUsdCache ? "invalid-cache" : "missing-cache",
    ),
    EUR: null,
    CHF: null,
  };
}

export async function loadRiskFreeRateSnapshot(db: D1Database): Promise<YieldBenchmarkMeta> {
  const registry = await loadRiskFreeRateRegistry(db);
  return registry.USD;
}
