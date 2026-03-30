import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  fetchOnchainRateBps,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";

interface BranchConfig {
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

interface BranchBalanceParams {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  branches: BranchConfig[];
  redemptionRateProbe?: {
    contract: string;
    selector: string;
    decimals?: number;
  };
}

function readParams(config: LiveReservesConfig): BranchBalanceParams {
  const params = parseLiveReserveAdapterParams("evm-branch-balances", config.params);
  if (!Array.isArray(params.branches) || params.branches.length === 0) {
    throw new Error("evm-branch-balances adapter requires params.branches");
  }
  for (const branch of params.branches) {
    if (!branch || branch.priceUsd == null) continue;
    if (!Number.isFinite(branch.priceUsd) || branch.priceUsd <= 0) {
      throw new Error(`evm-branch-balances adapter received invalid priceUsd for ${branch.name}`);
    }
  }
  return params;
}

function getCoinIdFallbackPriceUsd(coinId: string | undefined): number | null {
  if (!coinId) return null;
  const meta = TRACKED_META_BY_ID.get(coinId);
  if (!meta) return null;
  return meta.flags.pegCurrency === "USD" ? 1 : null;
}

export async function fetchEvmBranchBalancesReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "evm-branch-balances");
  const params = readParams(config);

  const [balances, redemptionFeeBps] = await Promise.all([
    Promise.all(
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
        return {
          branch,
          balanceRaw: raw,
        };
      }),
    ),
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

  const unreadableBranches = balances
    .filter((entry) => entry.balanceRaw == null)
    .map((entry) => entry.branch.name);
  if (unreadableBranches.length > 0) {
    throw new Error(`evm-branch-balances adapter could not read balances for: ${unreadableBranches.join(", ")}`);
  }

  const pricedBranches = balances.filter((entry) => entry.balanceRaw != null && entry.balanceRaw > 0n);
  if (pricedBranches.length === 0) {
    throw new Error("evm-branch-balances adapter found no non-zero balances");
  }

  const branchesNeedingPrices = pricedBranches.filter(({ branch }) => branch.priceUsd == null);
  const priceMap = await fetchDefiLlamaPrices(
    branchesNeedingPrices.map(({ branch }) => ({
      key: branch.name,
      chain: branch.token.chain,
      address: branch.token.address,
    })),
    signal,
    ctx,
  );

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
      }),
      ...(redemptionFeeBps != null ? { redemptionFeeBps } : {}),
    },
  };
}
