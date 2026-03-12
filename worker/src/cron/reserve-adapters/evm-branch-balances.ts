import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import {
  fetchDefiLlamaPrices,
  fetchErc20Balance,
  requireOnchainInput,
  slicesFromUsdValues,
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

  const priceMap = await fetchDefiLlamaPrices(
    pricedBranches.map(({ branch }) => ({
      key: branch.name,
      chain: branch.token.chain,
      address: branch.token.address,
    })),
    signal,
  );

  const slices = slicesFromUsdValues(
    pricedBranches.map(({ branch, balance }) => {
      const price = priceMap.get(branch.name);
      if (price == null) {
        throw new Error(`Missing DefiLlama price for ${branch.name}`);
      }
      return {
        usd: (balance ?? 0) * price,
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
