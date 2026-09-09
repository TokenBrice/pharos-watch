import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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

export type BranchBalanceAdapterKey = Extract<LiveReserveAdapterKey, "evm-branch-balances" | "liquity-v2-branches" | "lista">;

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
  const meta = TRACKED_META_BY_ID.get(branch.coinId);
  // Yield-bearing wrappers (sUSDe, sDAI, sfrxUSD) rise above $1 by design; the peg
  // check would generate false-positive wrapper-depeg warnings for them.
  if (meta?.flags.yieldBearing) return false;
  return meta?.flags.pegCurrency === "USD";
}

function findUnderlyingContract(
  branch: BranchConfig,
): { chain: string; address: string } | null {
  if (!branch.coinId || branch.underlyingPrice1to1 !== true) return null;
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
    && /^0x[0-9a-fA-F]{40}$/.test(branch.token.address)
    && /^0x[0-9a-fA-F]{40}$/.test(branch.holder)
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

  // Configured-vs-on-chain decimals identity: a mismatched scale values every
  // branch by a power of ten, so a mismatch must reject the snapshot rather
  // than store a 10^12 valuation error. A reverting decimals() (non-ERC20) is
  // not an identity failure — keep the configured scale and surface it as info.
  for (const { branch, observedDecimals } of balances) {
    if (observedDecimals === undefined) continue;
    if (observedDecimals === null) {
      warnings.push(reserveInfoWarning(
        "branch-token-decimals-unavailable",
        `${adapterKey} could not read decimals() for ${branch.name}; using configured ${branch.token.decimals}`,
      ));
    } else if (observedDecimals !== BigInt(branch.token.decimals)) {
      warnings.push(reserveFatalWarning(
        "branch-token-decimals-mismatch",
        `${adapterKey} token ${branch.name} (${branch.token.address}) decimals mismatch: configured ${branch.token.decimals}, observed ${observedDecimals}`,
      ));
    }
  }

  const values = pricedBranches.map(({ branch, balanceRaw, balanceDecimals }) => {
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
      ...(adapterKey === "lista"
        ? {}
        : { sourceKey: `${adapterKey}:${branch.chain ?? branch.token.chain}:${branch.token.address.toLowerCase()}` }),
      value: valueUsdFromBigIntPrice(balanceRaw ?? 0n, balanceDecimals ?? branch.token.decimals, price),
      name: branch.name,
      risk: branch.risk,
      ...(branch.coinId ? { coinId: branch.coinId } : {}),
      ...(branch.depType ? { depType: branch.depType } : {}),
    };
  });
  const totalValue = values.reduce((sum, value) => sum + value.value, 0);
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
  const slices = slicesFromValues(values, hasSubSixDecimalPercentBranch ? 6 : hasSubTenthPercentBranch ? 3 : 1);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      branchCount: pricedBranches.length,
      unknownExposurePct: 0,
      ...notApplicableFreshnessMetadata({
        proofKind: "onchain-branch-balances",
        ...details,
      }),
      ...metadata,
    },
  };
}
