import { fetchAccountableReserves } from "./accountable";
import { fetchAsymmetryReserves } from "./asymmetry";
import { fetchBtcfiReserves } from "./btcfi";
import { fetchCircleReserves } from "./circle-transparency";
import { fetchChainlinkNavReserves } from "./chainlink-nav";
import { fetchChainlinkPorReserves } from "./chainlink-por";
import { fetchCollateralPositionsApiReserves } from "./collateral-positions-api";
import { fetchCrvUsdReserves } from "./crvusd";
import { fetchCuratedValidatedReserves } from "./curated-validated";
import { fetchDolaInverseReserves } from "./dola-inverse";
import { fetchEvmBranchBalancesReserves } from "./evm-branch-balances";
import { fetchEthenaReserves } from "./ethena";
import { fetchFalconReserves } from "./falcon";
import { fetchFdusdTransparencyReserves } from "./fdusd-transparency";
import { fetchFraxReserves } from "./frax";
import { fetchFxReserves } from "./fx";
import { fetchGhoReserves } from "./gho";
import { fetchInfiniFiReserves } from "./infinifi";
import { fetchM0Reserves } from "./m0";
import { fetchMentoReserves } from "./mento";
import { fetchOpenEdenUsdoReserves } from "./openeden";
import { fetchReservoirReserves } from "./reservoir";
import { fetchErc4626SingleAssetReserves } from "./erc4626-single-asset";
import { fetchSgForgeCoinvertibleReserves } from "./sgforge-coinvertible";
import { fetchSingleAssetReserves } from "./single-asset";
import { fetchSkyMakercoreReserves } from "./sky-makercore";
import { fetchTetherReserves } from "./tether";
import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { ChainRpcConfig } from "../../lib/chain-registry";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  etherscanApiKey?: string;
  alchemyApiKey?: string;
  chainRpcs?: Map<string, ChainRpcConfig>;
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
  "chainlink-nav": fetchChainlinkNavReserves,
  "circle-transparency": fetchCircleReserves,
  "chainlink-por": fetchChainlinkPorReserves,
  "collateral-positions-api": fetchCollateralPositionsApiReserves,
  crvusd: fetchCrvUsdReserves,
  "curated-validated": fetchCuratedValidatedReserves,
  "dola-inverse": fetchDolaInverseReserves,
  "erc4626-single-asset": fetchErc4626SingleAssetReserves,
  "evm-branch-balances": fetchEvmBranchBalancesReserves,
  ethena: fetchEthenaReserves,
  falcon: fetchFalconReserves,
  "fdusd-transparency": fetchFdusdTransparencyReserves,
  frax: fetchFraxReserves,
  fx: fetchFxReserves,
  gho: fetchGhoReserves,
  infinifi: fetchInfiniFiReserves,
  m0: fetchM0Reserves,
  mento: fetchMentoReserves,
  "openeden-usdo": fetchOpenEdenUsdoReserves,
  reservoir: fetchReservoirReserves,
  "sgforge-coinvertible": fetchSgForgeCoinvertibleReserves,
  "single-asset": fetchSingleAssetReserves,
  "sky-makercore": fetchSkyMakercoreReserves,
  tether: fetchTetherReserves,
};

/** Returns the adapter function for the given key, or null if unknown. */
export function getReserveAdapter(adapterKey: string): AdapterFn | null {
  return ADAPTERS[adapterKey] ?? null;
}
