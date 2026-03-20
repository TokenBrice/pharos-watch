import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  requireOnchainInput,
  slicesFromValues,
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
}

function readParams(config: LiveReservesConfig): BranchBalanceParams {
  const params = (config.params ?? {}) as Partial<BranchBalanceParams>;
  if (!Array.isArray(params.branches) || params.branches.length === 0) {
    throw new Error("evm-branch-balances adapter requires params.branches");
  }
  for (const branch of params.branches) {
    if (!branch || branch.priceUsd == null) continue;
    if (!Number.isFinite(branch.priceUsd) || branch.priceUsd <= 0) {
      throw new Error(`evm-branch-balances adapter received invalid priceUsd for ${branch.name}`);
    }
  }
  return params as BranchBalanceParams;
}

export async function fetchEvmBranchBalancesReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "evm-branch-balances");
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
      return {
        branch,
        balance: raw == null ? null : Number(raw) / (10 ** branch.token.decimals),
      };
    }),
  );

  const pricedBranches = balances.filter((entry) => entry.balance != null && entry.balance > 0);
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
  );

  const slices = slicesFromValues(
    pricedBranches.map(({ branch, balance }) => {
      const price = branch.priceUsd ?? priceMap.get(branch.name);
      if (price == null) {
        throw new Error(`Missing DefiLlama price for ${branch.name}`);
      }
      return {
        value: (balance ?? 0) * price,
        name: branch.name,
        risk: branch.risk,
        ...(branch.coinId ? { coinId: branch.coinId } : {}),
        ...(branch.depType ? { depType: branch.depType } : {}),
      };
    }),
  );

  return {
    slices,
    metadata: { branchCount: pricedBranches.length },
  };
}
