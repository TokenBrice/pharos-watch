import { fetchAccountableReserves } from "./accountable";
import { fetchAsymmetryReserves } from "./asymmetry";
import { fetchBtcfiReserves } from "./btcfi";
import { fetchCollateralPositionsApiReserves } from "./collateral-positions-api";
import { fetchCrvUsdReserves } from "./crvusd";
import { fetchEvmBranchBalancesReserves } from "./evm-branch-balances";
import { fetchFxReserves } from "./fx";
import { fetchInfiniFiReserves } from "./infinifi";
import { fetchM0Reserves } from "./m0";
import { fetchOpenEdenUsdoReserves } from "./openeden";
import { fetchReservoirReserves } from "./reservoir";
import { fetchErc4626SingleAssetReserves } from "./erc4626-single-asset";
import { fetchSingleAssetReserves } from "./single-asset";
import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  etherscanApiKey?: string;
  alchemyApiKey?: string;
}

export interface AdapterResult {
  slices: ReserveSlice[];
  warnings?: LiveReserveWarning[];
  metadata?: Record<string, unknown>;
}

type AdapterFn = (
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) => Promise<AdapterResult>;

const ADAPTERS: Record<string, AdapterFn> = {
  accountable: fetchAccountableReserves,
  asymmetry: fetchAsymmetryReserves,
  btcfi: fetchBtcfiReserves,
  "collateral-positions-api": fetchCollateralPositionsApiReserves,
  crvusd: fetchCrvUsdReserves,
  "erc4626-single-asset": fetchErc4626SingleAssetReserves,
  "evm-branch-balances": fetchEvmBranchBalancesReserves,
  fx: fetchFxReserves,
  infinifi: fetchInfiniFiReserves,
  m0: fetchM0Reserves,
  "openeden-usdo": fetchOpenEdenUsdoReserves,
  reservoir: fetchReservoirReserves,
  "single-asset": fetchSingleAssetReserves,
};

/** Returns the adapter function for the given key, or null if unknown. */
export function getReserveAdapter(adapterKey: string): AdapterFn | null {
  return ADAPTERS[adapterKey] ?? null;
}
