import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { DECIMALS_SELECTOR, encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import { ERC4626_ASSET_SELECTOR, ERC4626_TOTAL_ASSETS_SELECTOR } from "./erc4626";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchErc20Balance,
  fetchOnchainMulticall3,
  fetchOnchainRateBps,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  probeOptionalRedemptionRateBps,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";
import {
  adaptBranchBalanceReserves,
  fetchBranchPriceMap,
  readBranchBalanceParams,
  type BranchConfig,
  type BranchBalanceEntry,
  type BranchBalanceParams,
} from "./branch-balances";
import {
  decodeAddressWord,
  decodeBoolWord,
  decodeUint256Word,
  decodeUint8Word,
} from "./abi-decode";

const ADAPTER_KEY = "liquity-v2-branches";
const DEFAULT_DEBT_SELECTOR = "0x45507998"; // getBoldDebt()
const DEFAULT_SHUTDOWN_SELECTOR = "0x06ff8dfb"; // hasBeenShutDown()
const DEFAULT_DEBT_DECIMALS = 18;
const BRANCH_PRICE_SELECTOR = "0x0fdb11cf"; // fetchPrice()
const BRANCH_REDEMPTION_RATE_SELECTOR = "0xc52861f2"; // getRedemptionRateWithDecay()

interface LiquityV2BranchDebt {
  entry: BranchBalanceEntry;
  debtRaw: bigint | null;
  shutDown: boolean | null;
  redemptionFeeBps: number | null;
}

interface LiquityV2BranchSnapshot {
  balances: BranchBalanceEntry[];
  debts: LiquityV2BranchDebt[];
  redemptionFeeBps: number | null;
}

interface LiquityV2BranchParams extends BranchBalanceParams {
  debtSelector?: string;
  debtDecimals?: number;
  shutdownSelector?: string;
}

function readParams(config: LiveReservesConfig): LiquityV2BranchParams {
  return readBranchBalanceParams(config, ADAPTER_KEY) as LiquityV2BranchParams;
}

function sumBranchDebtUsd(
  debts: LiquityV2BranchDebt[],
  debtDecimals: number,
): number {
  return debts.reduce((sum, entry) => (
    entry.debtRaw != null && entry.debtRaw > 0n
      ? sum + decimalNumberFromBigInt(entry.debtRaw, debtDecimals)
      : sum
  ), 0);
}

function computeErc4626AssetsFromShares(
  sharesRaw: bigint,
  totalAssetsRaw: bigint,
  totalSupplyRaw: bigint,
): bigint {
  if (sharesRaw <= 0n || totalAssetsRaw <= 0n || totalSupplyRaw <= 0n) return 0n;
  return (sharesRaw * totalAssetsRaw) / totalSupplyRaw;
}

async function tryAdaptErc4626ShareEntry(
  input: ReturnType<typeof requireOnchainInput>,
  entry: BranchBalanceEntry,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  params: LiquityV2BranchParams,
  timeoutMs: number,
): Promise<BranchBalanceEntry> {
  if (entry.balanceRaw == null || entry.balanceRaw <= 0n) return entry;

  const assetRaw = await fetchOnchainRawCall({
    contract: entry.branch.token.address,
    data: ERC4626_ASSET_SELECTOR,
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    rpcMode: input.rpcMode,
    chain: input.chain,
    timeoutMs,
  });
  const assetAddress = decodeAddressWord(assetRaw);
  if (!assetAddress) return entry;

  const [totalAssetsRaw, totalSupplyRaw, decimalsRaw] = await Promise.all([
    fetchOnchainUint256({
      contract: entry.branch.token.address,
      data: ERC4626_TOTAL_ASSETS_SELECTOR,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      rpcMode: input.rpcMode,
      chain: input.chain,
      timeoutMs,
    }),
    fetchOnchainUint256({
      contract: entry.branch.token.address,
      data: TOTAL_SUPPLY_SELECTOR,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      rpcMode: input.rpcMode,
      chain: input.chain,
      timeoutMs,
    }),
    fetchOnchainRawCall({
      contract: assetAddress,
      data: DECIMALS_SELECTOR,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      rpcMode: input.rpcMode,
      chain: input.chain,
      timeoutMs,
    }),
  ]);
  if (totalAssetsRaw == null || totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    return entry;
  }

  const assetBalanceRaw = computeErc4626AssetsFromShares(entry.balanceRaw, totalAssetsRaw, totalSupplyRaw);
  const assetDecimals = decodeUint8Word(decimalsRaw) ?? entry.branch.token.decimals;
  return {
    ...entry,
    balanceRaw: assetBalanceRaw,
    branch: {
      ...entry.branch,
      token: {
        ...entry.branch.token,
        address: assetAddress,
        decimals: assetDecimals,
      },
    },
  };
}

async function fetchLiquityV2BranchBalances(
  input: ReturnType<typeof requireOnchainInput>,
  params: LiquityV2BranchParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  timeoutMs: number,
): Promise<BranchBalanceEntry[]> {
  const balanceCalls = params.branches.map((branch, index) => ({
    label: `balance:${index}`,
    contract: branch.token.address,
    data: encodeBalanceOfCallData(branch.holder),
    allowFailure: true,
  }));

  const multicallResults = await fetchOnchainMulticall3({
    calls: balanceCalls,
    signal,
    ctx,
    chain: input.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  if (multicallResults && multicallResults.length === balanceCalls.length) {
    const balances = multicallResults.map((result, index) => {
      const branch = params.branches[index]!;
      const balanceRaw = result.success ? decodeUint256Word(result.returnData) : null;
      return { branch, balanceRaw };
    });
    const unreadable = balances.some((entry) => entry.balanceRaw == null);
    if (!unreadable) {
      const adapted = await Promise.all(
        balances.map((entry) => tryAdaptErc4626ShareEntry(input, entry, signal, ctx, params, timeoutMs)),
      );
      return adapted;
    }
  }

  const shareEntries = await Promise.all(
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

  return Promise.all(
    shareEntries.map((entry) => tryAdaptErc4626ShareEntry(input, entry, signal, ctx, params, timeoutMs)),
  );
}

async function fetchBranchProtocolPriceMap(
  input: ReturnType<typeof requireOnchainInput>,
  balances: BranchBalanceEntry[],
  existingPriceMap: Map<string, number>,
  signal: AbortSignal,
  warnings: LiveReserveWarning[],
  ctx: AdapterContext | undefined,
  params: LiquityV2BranchParams,
  timeoutMs: number,
): Promise<Map<string, number>> {
  const missingPricedBranches = balances.filter(
    ({ branch, balanceRaw }) => balanceRaw != null
      && balanceRaw > 0n
      && branch.priceUsd == null
      && !existingPriceMap.has(branch.name),
  );
  if (missingPricedBranches.length === 0) return new Map();

  const protocolPriceMap = new Map<string, number>();
  await Promise.all(missingPricedBranches.map(async ({ branch }) => {
    const priceRaw = await fetchOnchainUint256({
      contract: branch.holder,
      data: BRANCH_PRICE_SELECTOR,
      signal,
      ctx,
      rpcUrl: params.rpcUrl,
      fallbackRpcUrl: params.fallbackRpcUrl,
      rpcMode: input.rpcMode,
      chain: input.chain,
      timeoutMs,
    });
    if (priceRaw == null || priceRaw <= 0n) return;
    const priceUsd = decimalNumberFromBigInt(priceRaw, 18);
    if (Number.isFinite(priceUsd) && priceUsd > 0) {
      protocolPriceMap.set(branch.name, priceUsd);
    }
  }));

  if (protocolPriceMap.size > 0) {
    warnings.push(reserveInfoWarning(
      "branch-protocol-price-fallback",
      `Used branch oracle price fallback for: ${[...protocolPriceMap.keys()].join(", ")}`,
    ));
  }
  return protocolPriceMap;
}

async function probeBranchRedemptionFeeBps(
  input: ReturnType<typeof requireOnchainInput>,
  branch: BranchConfig,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  params: LiquityV2BranchParams,
): Promise<number | null> {
  return fetchOnchainRateBps(
    input,
    { contract: branch.holder, selector: BRANCH_REDEMPTION_RATE_SELECTOR },
    signal,
    ctx,
    params.rpcUrl,
    params.fallbackRpcUrl,
  );
}

function chooseSnapshotRedemptionFeeBps(
  explicitFeeBps: number | null,
  debts: LiquityV2BranchDebt[],
): number | null {
  if (explicitFeeBps != null) return explicitFeeBps;
  const readableFees = debts
    .map((entry) => entry.redemptionFeeBps)
    .filter((fee): fee is number => fee != null);
  if (readableFees.length === 0) return null;
  return Math.max(...readableFees);
}

export function buildLiquityV2RedemptionMetadata(
  snapshot: LiquityV2BranchSnapshot,
  debtDecimals = DEFAULT_DEBT_DECIMALS,
  sourceUrls: string[] = [
    "https://docs.liquity.org/v2-faq/redemptions-and-delegation",
    "https://docs.liquity.org/v2-faq/technical-resources",
  ],
): NonNullable<AdapterResult["metadata"]> {
  const capacityUsd = sumBranchDebtUsd(snapshot.debts, debtDecimals);
  if (capacityUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} active-pool debt reads returned zero capacity`);
  }

  const shutdownBranches = snapshot.debts
    .filter((entry) => entry.shutDown === true)
    .map((entry) => entry.entry.branch.name);
  const unreadableShutdownBranches = snapshot.debts
    .filter((entry) => entry.shutDown == null)
    .map((entry) => entry.entry.branch.name);
  const routeStatus = shutdownBranches.length > 0
    ? "degraded"
    : unreadableShutdownBranches.length > 0
      ? "unknown"
      : "open";
  const routeStatusReason =
    shutdownBranches.length > 0
      ? `Collateral branch shutdown/sunset detected for: ${shutdownBranches.join(", ")}`
      : unreadableShutdownBranches.length > 0
        ? `Could not verify branch shutdown status for: ${unreadableShutdownBranches.join(", ")}`
        : undefined;

  return {
    totalDebtUsd: capacityUsd,
    immediateRedeemableUsd: capacityUsd,
    ...buildRedemptionSnapshotMetadata({
      capacityUsd,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus,
      routeStatusSource: "onchain",
      ...(routeStatusReason ? { routeStatusReason } : {}),
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
      sourceUrls,
      feeBps: snapshot.redemptionFeeBps,
    }),
    details: {
      proofKind: "liquity-v2-active-pool-debt",
      branchDebt: snapshot.debts.map((entry) => ({
        name: entry.entry.branch.name,
        debtRaw: entry.debtRaw?.toString() ?? null,
        shutDown: entry.shutDown,
        redemptionFeeBps: entry.redemptionFeeBps,
      })),
      ...(unreadableShutdownBranches.length > 0 ? { unreadableShutdownBranches } : {}),
    },
  };
}

export function buildLiquityV2Warnings(
  snapshot: LiquityV2BranchSnapshot,
): LiveReserveWarning[] {
  const unreadableShutdownBranches = snapshot.debts
    .filter((entry) => entry.shutDown == null)
    .map((entry) => entry.entry.branch.name);
  if (unreadableShutdownBranches.length === 0) return [];
  return [
    reserveDegradedWarning(
      "redemption-route-status-unreadable",
      `Could not verify branch shutdown status for: ${unreadableShutdownBranches.join(", ")}`,
    ),
  ];
}

export async function fetchLiquityV2BranchReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readParams(config);
  const debtSelector = params.debtSelector ?? DEFAULT_DEBT_SELECTOR;
  const shutdownSelector = params.shutdownSelector ?? DEFAULT_SHUTDOWN_SELECTOR;
  const debtDecimals = params.debtDecimals ?? DEFAULT_DEBT_DECIMALS;
  const timeoutMs = 12_000;

  const [balances, redemptionFeeBps] = await Promise.all([
    fetchLiquityV2BranchBalances(input, params, signal, ctx, timeoutMs),
    probeOptionalRedemptionRateBps(
      input,
      params.redemptionRateProbe,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
  ]);
  const debtCalls = balances.flatMap((entry, index) => [
    {
      label: `debt:${index}`,
      contract: entry.branch.holder,
      data: debtSelector,
      allowFailure: true,
    },
    {
      label: `shutdown:${index}`,
      contract: entry.branch.holder,
      data: shutdownSelector,
      allowFailure: true,
    },
  ]);

  const multicallDebts = await fetchOnchainMulticall3({
    calls: debtCalls,
    signal,
    ctx,
    chain: input.chain,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const multicallDebtReads = multicallDebts && multicallDebts.length === debtCalls.length
    ? await Promise.all(
      balances.map(async (entry, index) => {
        const debtResult = multicallDebts[index * 2];
        const shutdownResult = multicallDebts[index * 2 + 1];
        const branchRedemptionFeeBps = params.redemptionRateProbe
          ? null
          : await probeBranchRedemptionFeeBps(input, entry.branch, signal, ctx, params);
        return {
          entry,
          debtRaw: debtResult?.success ? decodeUint256Word(debtResult.returnData) : null,
          shutDown: shutdownResult?.success ? decodeBoolWord(shutdownResult.returnData) : null,
          redemptionFeeBps: branchRedemptionFeeBps,
        };
      }),
    )
    : null;

  const debts = multicallDebtReads && multicallDebtReads.every((entry) => entry.debtRaw != null)
    ? multicallDebtReads
    : await Promise.all(
      balances.map(async (entry) => {
        const [debtRaw, shutDownRaw, branchRedemptionFeeBps] = await Promise.all([
          fetchOnchainUint256({
            contract: entry.branch.holder,
            data: debtSelector,
            signal,
            ctx,
            rpcUrl: params.rpcUrl,
            fallbackRpcUrl: params.fallbackRpcUrl,
            rpcMode: input.rpcMode,
            chain: input.chain,
            timeoutMs,
          }),
          fetchOnchainRawCall({
            contract: entry.branch.holder,
            data: shutdownSelector,
            signal,
            ctx,
            rpcUrl: params.rpcUrl,
            fallbackRpcUrl: params.fallbackRpcUrl,
            rpcMode: input.rpcMode,
            chain: input.chain,
            timeoutMs,
          }),
          params.redemptionRateProbe
            ? Promise.resolve(null)
            : probeBranchRedemptionFeeBps(input, entry.branch, signal, ctx, params),
        ]);
        return {
          entry,
          debtRaw,
          shutDown: decodeBoolWord(shutDownRaw),
          redemptionFeeBps: branchRedemptionFeeBps,
        };
      }),
    );

  const unreadableDebtBranches = debts
    .filter((entry) => entry.debtRaw == null)
    .map((entry) => entry.entry.branch.name);
  if (unreadableDebtBranches.length > 0) {
    throw new Error(`${ADAPTER_KEY} could not read active-pool debt for: ${unreadableDebtBranches.join(", ")}`);
  }

  const priceMapWarnings: LiveReserveWarning[] = [];
  const priceMap = await fetchBranchPriceMap(balances, signal, priceMapWarnings, ctx);
  const protocolPriceMap = await fetchBranchProtocolPriceMap(
    input,
    balances,
    priceMap,
    signal,
    priceMapWarnings,
    ctx,
    params,
    timeoutMs,
  );
  for (const [name, price] of protocolPriceMap) {
    if (!priceMap.has(name)) {
      priceMap.set(name, price);
    }
  }
  const snapshot = {
    balances,
    debts,
    redemptionFeeBps: chooseSnapshotRedemptionFeeBps(redemptionFeeBps, debts),
  };
  const result = adaptBranchBalanceReserves({
    adapterKey: ADAPTER_KEY,
    balances,
    priceMap,
    metadata: buildLiquityV2RedemptionMetadata(snapshot, debtDecimals, params.sourceUrls),
  });
  const warnings = [...buildLiquityV2Warnings(snapshot), ...priceMapWarnings];
  return warnings.length > 0
    ? { ...result, warnings: [...(result.warnings ?? []), ...warnings] }
    : result;
}
