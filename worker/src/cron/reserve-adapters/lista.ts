import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  requireOnchainInput,
} from "./helpers";
import {
  adaptBranchBalanceReserves,
  fetchBranchBalances,
  fetchBranchPriceMap,
  readBranchBalanceParams,
  type BranchBalanceEntry,
} from "./branch-balances";

const ADAPTER_KEY = "lista";

export interface ListaAdaptInput {
  balances: BranchBalanceEntry[];
  priceMap: Map<string, number>;
}

/**
 * Pure transform: converts raw on-chain balance + price data into reserve slices.
 * Exported for unit testing.
 */
export function adaptListaReserves(input: ListaAdaptInput): AdapterResult {
  return adaptBranchBalanceReserves({
    adapterKey: ADAPTER_KEY,
    balances: input.balances,
    priceMap: input.priceMap,
    details: { protocol: "lista-dao" },
  });
}

export async function fetchListaReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readBranchBalanceParams(config, ADAPTER_KEY);
  const balances = await fetchBranchBalances(input, params, signal, ctx);
  const priceMap = await fetchBranchPriceMap(balances, signal, ctx);

  return adaptListaReserves({ balances, priceMap });
}
