import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchOnchainRateBps,
  fetchOnchainRawCall,
  fetchOnchainUint256,
  requireOnchainInput,
} from "./helpers";
import {
  adaptBranchBalanceReserves,
  fetchBranchBalances,
  fetchBranchPriceMap,
  readBranchBalanceParams,
  type BranchBalanceEntry,
  type BranchBalanceParams,
} from "./branch-balances";

const ADAPTER_KEY = "liquity-v2-branches";
const DEFAULT_DEBT_SELECTOR = "0x45507998"; // getBoldDebt()
const DEFAULT_SHUTDOWN_SELECTOR = "0x06ff8dfb"; // hasBeenShutDown()
const DEFAULT_DEBT_DECIMALS = 18;

interface LiquityV2BranchDebt {
  entry: BranchBalanceEntry;
  debtRaw: bigint | null;
  shutDown: boolean | null;
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

function parseBoolResult(raw: string | null): boolean | null {
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return BigInt(raw) !== 0n;
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

export function buildLiquityV2RedemptionMetadata(
  snapshot: LiquityV2BranchSnapshot,
  debtDecimals = DEFAULT_DEBT_DECIMALS,
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
  const routeStatus = shutdownBranches.length === 0 ? "open" : "degraded";
  const routeStatusReason =
    shutdownBranches.length > 0
      ? `Collateral branch shutdown detected for: ${shutdownBranches.join(", ")}`
      : unreadableShutdownBranches.length > 0
        ? `Could not verify branch shutdown status for: ${unreadableShutdownBranches.join(", ")}`
        : undefined;

  return {
    totalDebtUsd: capacityUsd,
    immediateRedeemableUsd: capacityUsd,
    ...(snapshot.redemptionFeeBps != null ? { redemptionFeeBps: snapshot.redemptionFeeBps } : {}),
    redemption: {
      capacityUsd,
      capacityKind: "live-direct-bounded" as const,
      freshnessKind: "same-run-onchain" as const,
      routeStatus,
      ...(routeStatusReason ? { routeStatusReason } : {}),
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
      ...(snapshot.redemptionFeeBps != null ? { feeBps: snapshot.redemptionFeeBps } : {}),
    },
    details: {
      proofKind: "liquity-v2-active-pool-debt",
      branchDebt: snapshot.debts.map((entry) => ({
        name: entry.entry.branch.name,
        debtRaw: entry.debtRaw?.toString() ?? null,
        shutDown: entry.shutDown,
      })),
    },
  };
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
    fetchBranchBalances(input, params, signal, ctx),
    params.redemptionRateProbe
      ? fetchOnchainRateBps(
          input,
          params.redemptionRateProbe,
          signal,
          ctx,
          params.rpcUrl,
          params.fallbackRpcUrl,
        )
      : Promise.resolve(null),
  ]);
  const debts = await Promise.all(
    balances.map(async (entry) => {
      const [debtRaw, shutDownRaw] = await Promise.all([
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
      ]);
      return {
        entry,
        debtRaw,
        shutDown: parseBoolResult(shutDownRaw),
      };
    }),
  );

  const unreadableDebtBranches = debts
    .filter((entry) => entry.debtRaw == null)
    .map((entry) => entry.entry.branch.name);
  if (unreadableDebtBranches.length > 0) {
    throw new Error(`${ADAPTER_KEY} could not read active-pool debt for: ${unreadableDebtBranches.join(", ")}`);
  }

  const priceMap = await fetchBranchPriceMap(balances, signal, ctx);
  return adaptBranchBalanceReserves({
    adapterKey: ADAPTER_KEY,
    balances,
    priceMap,
    metadata: buildLiquityV2RedemptionMetadata({ balances, debts, redemptionFeeBps }, debtDecimals),
  });
}
