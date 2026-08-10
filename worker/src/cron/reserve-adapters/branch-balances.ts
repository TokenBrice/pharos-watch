import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ReserveSlice } from "@shared/types/core";
import type { LiveReserveAdapterKey, LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../lib/stablecoins-cache";
import type { OnchainRateProbe } from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";
import { getCachedRequest } from "./request";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";

export type BranchBalanceAdapterKey = Extract<LiveReserveAdapterKey, "evm-branch-balances" | "liquity-v2-branches" | "lista">;

const STABLECOINS_CACHE_BRANCH_PRICE_MAX_AGE_SEC = 2 * 60 * 60;

export interface BranchConfig {
  name: string;
  holder: string;
  token: {
    chain: string;
    address: string;
    decimals: number;
  };
  priceToken?: {
    chain: string;
    address: string;
  };
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  priceUsd?: number;
}

export interface BranchBalanceParams {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  branches: BranchConfig[];
  sourceUrls?: string[];
  redemptionRateProbe?: OnchainRateProbe;
  debtSelector?: string;
  debtContract?: string;
  debtDecimals?: number;
}

export interface BranchBalanceEntry {
  branch: BranchConfig;
  balanceRaw: bigint | null;
}

export interface AdaptBranchBalanceInput {
  adapterKey: BranchBalanceAdapterKey;
  balances: BranchBalanceEntry[];
  priceMap: Map<string, number>;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

type OnchainInput = ReturnType<typeof requireOnchainInput>;

export function readBranchBalanceParams(
  config: LiveReservesConfig,
  adapterKey: BranchBalanceAdapterKey,
): BranchBalanceParams {
  return parseLiveReserveAdapterParams(adapterKey, config.params) as BranchBalanceParams;
}

function isUsdPeggedBranch(branch: BranchConfig): boolean {
  if (branch.depType === "wrapper") return false;
  if (!branch.coinId) return false;
  const meta = TRACKED_META_BY_ID.get(branch.coinId);
  // Yield-bearing wrappers (sUSDe, sDAI, sfrxUSD) rise above $1 by design; the peg
  // check would generate false-positive wrapper-depeg warnings for them.
  if (meta?.flags.yieldBearing) return false;
  return meta?.flags.pegCurrency === "USD";
}

function findUnderlyingContract(
  branch: BranchConfig,
): { chain: string; address: string } | null {
  if (!branch.coinId) return null;
  const meta = TRACKED_META_BY_ID.get(branch.coinId);
  if (!meta?.contracts) return null;
  const sameChain = meta.contracts.find((c) => c.chain === branch.token.chain);
  if (sameChain) return { chain: sameChain.chain, address: sameChain.address };
  const first = meta.contracts[0];
  return first ? { chain: first.chain, address: first.address } : null;
}

async function loadCachedStablecoinPricesById(
  warnings: LiveReserveWarning[],
  ctx?: AdapterContext,
): Promise<Map<string, number>> {
  if (!ctx?.db) return new Map();

  return getCachedRequest("stablecoins-cache:branch-prices", async () => {
    const loaded = await loadStablecoinsCache(ctx.db!, {
      mode: "lenient",
      contract: "critical-fields",
    });
    if (!hasUsableStablecoinsPayload(loaded)) return new Map<string, number>();

    const now = ctx.nowSec ?? Math.floor(Date.now() / 1000);
    if (loaded.updatedAt == null || loaded.updatedAt <= 0) {
      return new Map<string, number>();
    }
    const ageSec = now - loaded.updatedAt;
    if (ageSec > STABLECOINS_CACHE_BRANCH_PRICE_MAX_AGE_SEC) {
      warnings.push(reserveInfoWarning(
        "branch-price-cache-stale",
        `Branch-price cache is ${ageSec}s old (> ${STABLECOINS_CACHE_BRANCH_PRICE_MAX_AGE_SEC}s threshold); ` +
          "tracked-coin fallback prices unavailable until next stablecoins-cache refresh.",
      ));
      return new Map<string, number>();
    }

    const prices = new Map<string, number>();
    for (const asset of loaded.payload.peggedAssets) {
      if (typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0) {
        prices.set(asset.id, asset.price);
      }
    }
    return prices;
  }, ctx);
}

async function fetchCachedTrackedBranchPrices(
  branches: BranchBalanceEntry[],
  priceMap: Map<string, number>,
  warnings: LiveReserveWarning[],
  ctx?: AdapterContext,
): Promise<Map<string, number>> {
  const branchesNeedingCachedPrices = branches.filter(({ branch, balanceRaw }) =>
    balanceRaw != null
    && balanceRaw > 0n
    && branch.priceUsd == null
    && branch.coinId != null
    && !priceMap.has(branch.name)
  );
  if (branchesNeedingCachedPrices.length === 0) return new Map();

  const cachedPricesById = await loadCachedStablecoinPricesById(warnings, ctx);
  const cachedBranchPrices = new Map<string, number>();
  for (const { branch } of branchesNeedingCachedPrices) {
    const price = branch.coinId ? cachedPricesById.get(branch.coinId) : undefined;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      cachedBranchPrices.set(branch.name, price);
    }
  }
  return cachedBranchPrices;
}

export async function fetchBranchBalances(
  input: OnchainInput,
  params: BranchBalanceParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<BranchBalanceEntry[]> {
  return Promise.all(
    params.branches.map(async (branch) => {
      const raw = await fetchErc20Balance(
        input,
        branch.token.address,
        branch.holder,
        signal,
        ctx,
        params.rpcUrl,
        params.fallbackRpcUrl,
      );
      return { branch, balanceRaw: raw };
    }),
  );
}

export async function fetchBranchPriceMap(
  balances: BranchBalanceEntry[],
  signal: AbortSignal,
  warnings: LiveReserveWarning[],
  ctx?: AdapterContext,
): Promise<Map<string, number>> {
  const branchesNeedingPrices = balances
    .filter(({ branch, balanceRaw }) => balanceRaw != null && balanceRaw > 0n && branch.priceUsd == null);
  if (branchesNeedingPrices.length === 0) return new Map();

  const wrapperPriceMap = await fetchDefiLlamaPrices(
    branchesNeedingPrices.map(({ branch }) => ({
      key: branch.name,
      chain: branch.priceToken?.chain ?? branch.token.chain,
      address: branch.priceToken?.address ?? branch.token.address,
    })),
    signal,
    ctx,
  );

  // For branches the wrapper-address lookup didn't resolve, fall back to the
  // underlying coin's canonical contract price (no silent $1 clamp).
  const underlyingLookups = branchesNeedingPrices
    .filter(({ branch }) => !wrapperPriceMap.has(branch.name))
    .map(({ branch }) => {
      const underlying = findUnderlyingContract(branch);
      return underlying ? { branch, underlying } : null;
    })
    .filter(
      (entry): entry is { branch: BranchConfig; underlying: { chain: string; address: string } } =>
        entry != null,
    );

  if (underlyingLookups.length > 0) {
    const underlyingPriceMap = await fetchDefiLlamaPrices(
      underlyingLookups.map(({ branch, underlying }) => ({
        key: branch.name,
        chain: underlying.chain,
        address: underlying.address,
      })),
      signal,
      ctx,
    );
    for (const [name, price] of underlyingPriceMap) {
      if (!wrapperPriceMap.has(name)) {
        wrapperPriceMap.set(name, price);
      }
    }
  }

  const cachedTrackedPrices = await fetchCachedTrackedBranchPrices(branchesNeedingPrices, wrapperPriceMap, warnings, ctx);
  for (const [name, price] of cachedTrackedPrices) {
    if (!wrapperPriceMap.has(name)) {
      wrapperPriceMap.set(name, price);
    }
  }

  return wrapperPriceMap;
}

export function adaptBranchBalanceReserves(input: AdaptBranchBalanceInput): AdapterResult {
  const { adapterKey, balances, priceMap, details, metadata } = input;

  const unreadableBranches = balances
    .filter((entry) => entry.balanceRaw == null)
    .map((entry) => entry.branch.name);
  if (unreadableBranches.length > 0) {
    throw new Error(`${adapterKey} adapter could not read balances for: ${unreadableBranches.join(", ")}`);
  }

  const pricedBranches = balances.filter((entry) => entry.balanceRaw != null && entry.balanceRaw > 0n);
  if (pricedBranches.length === 0) {
    throw new Error(`${adapterKey} adapter found no non-zero balances`);
  }

  const warnings: LiveReserveWarning[] = [];

  const slices = slicesFromValues(
    pricedBranches.map(({ branch, balanceRaw }) => {
      const price = branch.priceUsd ?? priceMap.get(branch.name);
      if (price == null) {
        throw new Error(`Missing DefiLlama price for ${branch.name}`);
      }
      // Apply depeg policy tiers to USD-pegged branches when the price came
      // from a live source (no explicit override).
      if (isUsdPeggedBranch(branch) && branch.priceUsd == null) {
        if (price < 0.5 || price > 1.5) {
          throw new Error(
            `${adapterKey} adapter: extreme depeg on wrapper ${branch.name} (price $${price.toFixed(4)})`,
          );
        }
        if (price < 0.95 || price > 1.05) {
          warnings.push(reserveDegradedWarning(
            "wrapper-depeg-detected",
            `Wrapper ${branch.name} priced at $${price.toFixed(4)} vs USD peg`,
          ));
        }
      }
      return {
        value: valueUsdFromBigIntPrice(balanceRaw ?? 0n, branch.token.decimals, price),
        name: branch.name,
        risk: branch.risk,
        ...(branch.coinId ? { coinId: branch.coinId } : {}),
        ...(branch.depType ? { depType: branch.depType } : {}),
      };
    }),
  );

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      branchCount: pricedBranches.length,
      ...notApplicableFreshnessMetadata({
        proofKind: "onchain-branch-balances",
        ...details,
      }),
      ...metadata,
    },
  };
}
