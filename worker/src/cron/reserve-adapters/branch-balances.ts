import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { ReserveSlice } from "@shared/types/core";
import type { LiveReserveAdapterKey, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";

export type BranchBalanceAdapterKey = Extract<LiveReserveAdapterKey, "evm-branch-balances" | "lista">;

export interface BranchConfig {
  name: string;
  holder: string;
  token: {
    chain: string;
    address: string;
    decimals: number;
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
  redemptionRateProbe?: {
    contract: string;
    selector: string;
    decimals?: number;
  };
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

function getCoinIdFallbackPriceUsd(coinId: string | undefined): number | null {
  if (!coinId) return null;
  const meta = TRACKED_META_BY_ID.get(coinId);
  if (!meta) return null;
  return meta.flags.pegCurrency === "USD" ? 1 : null;
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
  ctx?: AdapterContext,
): Promise<Map<string, number>> {
  const branchesNeedingPrices = balances
    .filter(({ branch, balanceRaw }) => balanceRaw != null && balanceRaw > 0n && branch.priceUsd == null);
  return fetchDefiLlamaPrices(
    branchesNeedingPrices.map(({ branch }) => ({
      key: branch.name,
      chain: branch.token.chain,
      address: branch.token.address,
    })),
    signal,
    ctx,
  );
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

  const slices = slicesFromValues(
    pricedBranches.map(({ branch, balanceRaw }) => {
      const price = branch.priceUsd ?? priceMap.get(branch.name) ?? getCoinIdFallbackPriceUsd(branch.coinId);
      if (price == null) {
        throw new Error(`Missing DefiLlama price for ${branch.name}`);
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

