import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { LiveReserveAdapterKey, LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { DECIMALS_SELECTOR, encodeBalanceOfCallData } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { getCachedRequest } from "./request";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  fetchOnchainMulticall3,
  fetchOnchainUint256,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveFatalWarning,
  reserveInfoWarning,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";
import { decodeUint256Word } from "./abi-decode";

export type BranchBalanceAdapterKey = Extract<LiveReserveAdapterKey, "evm-branch-balances" | "liquity-v2-branches">;

const STABLECOINS_CACHE_BRANCH_PRICE_MAX_AGE_SEC = 2 * 60 * 60;

export type BranchBalanceParams = LiveReserveAdapterParamsByKey["evm-branch-balances"];
export type BranchConfig = BranchBalanceParams["branches"][number];

export interface BranchBalanceEntry {
  branch: BranchConfig;
  balanceRaw: bigint | null;
  /** decimals() read from the branch token; undefined = not probed, null = call reverted. */
  observedDecimals?: bigint | null;
  /** Converted underlying scale; the original token scale remains the identity gate. */
  balanceDecimals?: number;
}

export interface AdaptBranchBalanceInput {
  adapterKey: BranchBalanceAdapterKey;
  balances: BranchBalanceEntry[];
  priceMap: Map<string, number>;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** True only for a reviewed census or a same-run registry match. */
  censusComplete?: boolean;
  liabilityUsd?: number;
}

type OnchainInput = ReturnType<typeof requireOnchainInput>;

export function readBranchBalanceParams<K extends BranchBalanceAdapterKey>(
  config: LiveReservesConfig,
  adapterKey: K,
): LiveReserveAdapterParamsByKey[K] {
  return parseLiveReserveAdapterParams(adapterKey, config.params);
}

function isUsdPeggedBranch(branch: BranchConfig): boolean {
  if (branch.depType === "wrapper") return false;
  if (!branch.coinId) return false;
  const meta = WORKER_TRACKED_META_BY_ID.get(branch.coinId);
  // Yield-bearing wrappers (sUSDe, sDAI, sfrxUSD) rise above $1 by design; the peg
  // check would generate false-positive wrapper-depeg warnings for them.
  if (meta?.flags.yieldBearing) return false;
  return meta?.flags.pegCurrency === "USD";
}

function findUnderlyingContract(
  branch: BranchConfig,
): { chain: string; address: string } | null {
  if (!branch.coinId || branch.underlyingPrice1to1 !== true) return null;
  const meta = WORKER_TRACKED_META_BY_ID.get(branch.coinId);
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
    && branch.underlyingPrice1to1 === true
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
  const balanceCall = (branch: BranchConfig) => ({
    contract: branch.balanceRead?.contract ?? branch.token.address,
    data: branch.balanceRead
      ? branch.balanceRead.selector + (branch.balanceRead.args ?? []).map((word) => word.slice(2)).join("")
      : encodeBalanceOfCallData(branch.holder),
  });
  const convertReceipts = async (entries: BranchBalanceEntry[]): Promise<BranchBalanceEntry[]> =>
    Promise.all(entries.map(async (entry) => {
      const { branch } = entry;
      if (!branch.receipt || entry.balanceRaw == null || entry.balanceRaw === 0n) return entry;
      if (!branch.priceToken || branch.priceToken.chain !== input.chain) {
        throw new Error(`Compound receipt ${branch.name} requires a same-chain underlying priceToken`);
      }
      const read = (contract: string, data: string) => fetchOnchainUint256({
        contract, data, chain: input.chain, signal, ctx,
        rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl,
      });
      const [rate, underlying, decimals] = await Promise.all([
        read(branch.token.address, branch.receipt.exchangeRateSelector ?? "0x182df0f5"),
        read(branch.token.address, "0x6f307dc3"),
        read(branch.priceToken.address, DECIMALS_SELECTOR),
      ]);
      if (underlying !== BigInt(branch.priceToken.address) || decimals == null || decimals > 36n || rate == null || rate <= 0n) {
        throw new Error(`Compound receipt ${branch.name} underlying identity or exchange rate unavailable`);
      }
      // cToken human units × rate / 10^(18 + underlyingDecimals - cTokenDecimals).
      // In raw units the token decimal factors cancel; floor to whole underlying units.
      return { ...entry, balanceRaw: entry.balanceRaw * rate / 10n ** 18n, balanceDecimals: Number(decimals) };
    }));
  const fetchIndividually = () => Promise.all(
    params.branches.map(async (branch) => {
      const raw = branch.balanceRead
        ? await fetchOnchainUint256({
            ...balanceCall(branch), chain: input.chain, signal, ctx,
            rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl,
          })
        : await fetchErc20Balance(
            input, branch.token.address, branch.holder, signal, ctx, params.rpcUrl, params.fallbackRpcUrl,
          );
      const observedDecimals = branch.balanceRead || branch.receipt
        ? await fetchOnchainUint256({
            contract: branch.token.address, data: DECIMALS_SELECTOR, chain: input.chain, signal, ctx,
            rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl,
          })
        : undefined;
      return { branch, balanceRaw: raw, ...(observedDecimals !== undefined ? { observedDecimals } : {}) };
    }),
  );
  const isSingleChainEvmConfig = params.branches.every((branch) =>
    (branch.chain ?? branch.token.chain) === input.chain
    && canonicalEvmAddress(branch.token.address) !== null
    && canonicalEvmAddress(branch.holder) !== null
  );
  if (!isSingleChainEvmConfig) return convertReceipts(await fetchIndividually());

  const calls = params.branches.flatMap((branch, index) => [
    {
      label: `branch-balance:${index}`,
      ...balanceCall(branch),
      allowFailure: true,
    },
    {
      label: `branch-decimals:${index}`,
      contract: branch.token.address,
      data: DECIMALS_SELECTOR,
      allowFailure: true,
    },
  ]);
  const results = await fetchOnchainMulticall3({
    calls,
    chain: input.chain,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  if (results) {
    const rawByLabel = new Map(
      results.map((result) => [result.label, result.success ? result.returnData : null]),
    );
    return convertReceipts(params.branches.map((branch, index) => ({
      branch,
      balanceRaw: decodeUint256Word(rawByLabel.get(`branch-balance:${index}`)),
      observedDecimals: decodeUint256Word(rawByLabel.get(`branch-decimals:${index}`)),
    })));
  }

  return convertReceipts(await fetchIndividually());
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
    warnings,
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
      warnings,
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
  const { adapterKey, balances, priceMap, details, metadata, liabilityUsd } = input;
  const warnings: LiveReserveWarning[] = [];
  const unavailableBranches: Array<{ name: string; reason: string }> = [];
  const unclassifiedBranches: string[] = [];
  const observations: Array<Record<string, unknown>> = [];
  const values: Array<{
    sourceKey: string; value: number; name: string; risk: BranchConfig["risk"];
    coinId?: string; depType?: BranchConfig["depType"];
  }> = [];

  for (const { branch, balanceRaw, observedDecimals, balanceDecimals } of balances) {
    const price = branch.priceUsd ?? priceMap.get(branch.name);
    const observation: Record<string, unknown> = {
      name: branch.name, token: branch.token.address, chain: branch.chain ?? branch.token.chain,
      balanceRaw: balanceRaw == null ? null : balanceRaw.toString(),
      decimals: branch.token.decimals, observedDecimals: observedDecimals == null ? null : Number(observedDecimals),
      priceUsd: price ?? null,
    };
    observations.push(observation);
    if (balanceRaw == null) {
      unavailableBranches.push({ name: branch.name, reason: "balance-unavailable" });
      continue;
    }
    if (observedDecimals != null && observedDecimals !== BigInt(branch.token.decimals)) {
      warnings.push(reserveFatalWarning(
        "branch-token-decimals-mismatch",
        `${adapterKey} token ${branch.name} (${branch.token.address}) decimals mismatch: configured ${branch.token.decimals}, observed ${observedDecimals}`,
      ));
      unavailableBranches.push({ name: branch.name, reason: "decimals-mismatch" });
      continue;
    }
    if (observedDecimals === null) {
      warnings.push(reserveInfoWarning(
        "branch-token-decimals-unavailable",
        `${adapterKey} could not read decimals() for ${branch.name}; configured ${branch.token.decimals}`,
      ));
      if (input.censusComplete === true) {
        unavailableBranches.push({ name: branch.name, reason: "decimals-unavailable" });
        continue;
      }
    }
    // An observed zero needs no price and is not an unavailable constituent.
    if (balanceRaw === 0n) continue;
    if (branch.unclassifiedSelfReferential === true) {
      observation.classification = "unclassified-self-referential";
      unclassifiedBranches.push(branch.name);
      if (price == null || !Number.isFinite(price) || price <= 0) {
        unavailableBranches.push({ name: branch.name, reason: "price-unavailable" });
      }
      continue;
    }
    if (price == null || !Number.isFinite(price) || price <= 0) {
      unavailableBranches.push({ name: branch.name, reason: "price-unavailable" });
      continue;
    }
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
    values.push({
      sourceKey: `${adapterKey}:${branch.chain ?? branch.token.chain}:${branch.token.address.toLowerCase()}`,
      value: valueUsdFromBigIntPrice(balanceRaw, balanceDecimals ?? branch.token.decimals, price),
      name: branch.name,
      risk: branch.risk,
      ...(branch.coinId ? { coinId: branch.coinId } : {}),
      ...(branch.depType ? { depType: branch.depType } : {}),
    });
  }
  const totalValue = values.reduce((sum, value) => sum + value.value, 0);
  const partial = unavailableBranches.length > 0 || unclassifiedBranches.length > 0;
  const denominator = liabilityUsd != null && Number.isFinite(liabilityUsd) && liabilityUsd > 0
    ? liabilityUsd : null;
  // Liabilities are not a bound on unreadable collateral. A partial book
  // retains measured amounts as diagnostics, never invented reserve shares.
  const residualUsd = input.censusComplete === true && !partial ? 0 : null;
  const residualUnavailable = partial;
  if (values.length === 0 && !partial && denominator == null) {
    throw new Error(`${adapterKey} adapter found no non-zero balances`);
  }
  if (partial) {
    warnings.push(reserveDegradedWarning(
      "branch-reserve-book-partial",
      `${adapterKey} unavailable or unclassified constituents: ${[
        ...unavailableBranches.map(({ name, reason }) => `${name} (${reason})`),
        ...unclassifiedBranches.map((name) => `${name} (self-referential)`),
      ].join(", ")}`,
    ));
  }
  // The normal one-decimal display precision would drop a real sub-0.05%
  // branch to 0.0%, which can erase a reviewed dependency edge. Preserve such
  // measured branches at three decimals, or six decimals when three would
  // round a branch out, without inflating its value.
  const hasSubTenthPercentBranch = values.some(({ value }) =>
    Number.isFinite(value) && value > 0 && totalValue > 0 && (value / totalValue) * 100 < 0.05,
  );
  const hasSubSixDecimalPercentBranch = values.some(({ value }) =>
    Number.isFinite(value) && value > 0 && totalValue > 0 && (value / totalValue) * 100 < 0.0005,
  );
  const slices = residualUnavailable
    ? [{ name: "Unclassified or unavailable reserve residual", pct: 100, risk: "high" as const }]
    : slicesFromValues(values, hasSubSixDecimalPercentBranch ? 6 : hasSubTenthPercentBranch ? 3 : 1);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      branchCount: balances.filter(({ balanceRaw }) => balanceRaw != null && balanceRaw > 0n).length,
      ...notApplicableFreshnessMetadata({
        proofKind: "onchain-branch-balances",
        ...details,
      }),
      ...metadata,
      censusComplete: input.censusComplete === true,
      valuationComplete: !partial,
      ...(residualUnavailable
        ? { unknownExposurePct: 100, unknownExposureUnavailableReason: "partial-book-without-residual-bound" }
        : input.censusComplete === true
          ? { unknownExposurePct: 0 }
          : { unknownExposureUnavailableReason: "configured-branches-not-certified-census" }),
      details: {
        proofKind: "onchain-branch-balances",
        ...(metadata?.details as Record<string, unknown> | undefined),
        ...details,
        branchObservations: observations,
        unavailableBranches,
        unclassifiedSelfReferentialBranches: unclassifiedBranches,
        knownReserveValueUsd: totalValue,
        residualUsd,
        contextualObservationsOnly: residualUnavailable,
      },
    },
  };
}
