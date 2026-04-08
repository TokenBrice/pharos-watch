import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
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

interface ListaParams {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  branches: BranchConfig[];
}

const ADAPTER_KEY = "lista";

function readParams(config: LiveReservesConfig): ListaParams {
  const params = parseLiveReserveAdapterParams("lista", config.params);
  if (!Array.isArray(params.branches) || params.branches.length === 0) {
    throw new Error(`${ADAPTER_KEY} adapter requires params.branches`);
  }
  for (const branch of params.branches) {
    if (!branch || branch.priceUsd == null) continue;
    if (!Number.isFinite(branch.priceUsd) || branch.priceUsd <= 0) {
      throw new Error(`${ADAPTER_KEY} adapter received invalid priceUsd for ${branch.name}`);
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

export interface ListaAdaptInput {
  balances: Array<{
    branch: BranchConfig;
    balanceRaw: bigint | null;
  }>;
  priceMap: Map<string, number>;
}

/**
 * Pure transform: converts raw on-chain balance + price data into reserve slices.
 * Exported for unit testing.
 */
export function adaptListaReserves(input: ListaAdaptInput): AdapterResult {
  const { balances, priceMap } = input;

  const unreadableBranches = balances
    .filter((entry) => entry.balanceRaw == null)
    .map((entry) => entry.branch.name);
  if (unreadableBranches.length > 0) {
    throw new Error(`${ADAPTER_KEY} adapter could not read balances for: ${unreadableBranches.join(", ")}`);
  }

  const pricedBranches = balances.filter((entry) => entry.balanceRaw != null && entry.balanceRaw > 0n);
  if (pricedBranches.length === 0) {
    throw new Error(`${ADAPTER_KEY} adapter found no non-zero balances`);
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
        protocol: "lista-dao",
      }),
    },
  };
}

export async function fetchListaReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readParams(config);

  const balances = await Promise.all(
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

  const branchesNeedingPrices = balances
    .filter(({ branch, balanceRaw }) => balanceRaw != null && balanceRaw > 0n && branch.priceUsd == null);
  const priceMap = await fetchDefiLlamaPrices(
    branchesNeedingPrices.map(({ branch }) => ({
      key: branch.name,
      chain: branch.token.chain,
      address: branch.token.address,
    })),
    signal,
    ctx,
  );

  return adaptListaReserves({ balances, priceMap });
}
