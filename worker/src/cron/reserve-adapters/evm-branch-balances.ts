import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchOnchainRateBps,
  requireOnchainInput,
} from "./helpers";
import {
  adaptBranchBalanceReserves,
  fetchBranchBalances,
  fetchBranchPriceMap,
  readBranchBalanceParams,
} from "./branch-balances";

const ADAPTER_KEY = "evm-branch-balances";

export async function fetchEvmBranchBalancesReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readBranchBalanceParams(config, ADAPTER_KEY);

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

  const priceMap = await fetchBranchPriceMap(balances, signal, ctx);
  return adaptBranchBalanceReserves({
    adapterKey: ADAPTER_KEY,
    balances,
    priceMap,
    metadata: redemptionFeeBps != null ? { redemptionFeeBps } : undefined,
  });
}
