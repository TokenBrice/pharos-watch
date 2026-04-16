import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
} from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import { fetchAbracadabraReserves } from "./abracadabra";
import { fetchAccountableReserves } from "./accountable";
import { fetchAnzenUsdzReserves } from "./anzen-usdz";
import { fetchAsymmetryReserves } from "./asymmetry";
import { fetchBtcfiReserves } from "./btcfi";
import { fetchCapVaultReserves } from "./cap-vault";
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
import { fetchFraxBalanceSheetReserves } from "./frax";
import { fetchFxReserves } from "./fx";
import { fetchGhoReserves } from "./gho";
import { fetchInfiniFiReserves } from "./infinifi";
import { fetchJupUsdReserves } from "./jupusd";
import { fetchListaReserves } from "./lista";
import { fetchLiquityV1Reserves } from "./liquity-v1";
import { fetchLiquityV2BranchReserves } from "./liquity-v2-branches";
import { fetchM0Reserves } from "./m0";
import { fetchMentoReserves } from "./mento";
import { fetchOpenEdenUsdoReserves } from "./openeden";
import { fetchReMetricsReserves } from "./re-metrics";
import { fetchReservoirReserves } from "./reservoir";
import { fetchRiverProtocolInfoReserves } from "./river-protocol-info";
import { fetchErc4626SingleAssetReserves } from "./erc4626-single-asset";
import { fetchSgForgeCoinvertibleReserves } from "./sgforge-coinvertible";
import { fetchSingleAssetReserves } from "./single-asset";
import { fetchSkyMakercoreReserves } from "./sky-makercore";
import { fetchSolsticeAttestationReserves } from "./solstice-attestation";
import { fetchSuperstateLiquidityReserves } from "./superstate-liquidity";
import { fetchTetherReserves } from "./tether";
import { fetchUsdgoTransparencyReserves } from "./usdgo-transparency";
import { fetchUsdAiProofOfReserves } from "./usdai-proof-of-reserves";
import { fetchUsd1BundleOracleReserves } from "./usd1-bundle-oracle";
import { fetchUsddDataPlatformReserves } from "./usdd-data-platform";
import type { AdapterFn, ReserveAdapterDefinition } from "./types";

export type { AdapterContext, AdapterResult, AdapterFn, ReserveAdapterDefinition } from "./types";

const ADAPTER_FNS: Record<LiveReserveAdapterKey, AdapterFn> = {
  abracadabra: fetchAbracadabraReserves,
  accountable: fetchAccountableReserves,
  "anzen-usdz": fetchAnzenUsdzReserves,
  asymmetry: fetchAsymmetryReserves,
  btcfi: fetchBtcfiReserves,
  "cap-vault": fetchCapVaultReserves,
  "chainlink-nav": fetchChainlinkNavReserves,
  "circle-transparency": fetchCircleReserves,
  "chainlink-por": fetchChainlinkPorReserves,
  "collateral-positions-api": fetchCollateralPositionsApiReserves,
  crvusd: fetchCrvUsdReserves,
  "curated-validated": fetchCuratedValidatedReserves,
  "dola-inverse": fetchDolaInverseReserves,
  "erc4626-single-asset": fetchErc4626SingleAssetReserves,
  ethena: fetchEthenaReserves,
  "evm-branch-balances": fetchEvmBranchBalancesReserves,
  falcon: fetchFalconReserves,
  "fdusd-transparency": fetchFdusdTransparencyReserves,
  "frax-balance-sheet": fetchFraxBalanceSheetReserves,
  fx: fetchFxReserves,
  gho: fetchGhoReserves,
  infinifi: fetchInfiniFiReserves,
  jupusd: fetchJupUsdReserves,
  lista: fetchListaReserves,
  "liquity-v1": fetchLiquityV1Reserves,
  "liquity-v2-branches": fetchLiquityV2BranchReserves,
  m0: fetchM0Reserves,
  mento: fetchMentoReserves,
  "openeden-usdo": fetchOpenEdenUsdoReserves,
  "re-metrics": fetchReMetricsReserves,
  reservoir: fetchReservoirReserves,
  "river-protocol-info": fetchRiverProtocolInfoReserves,
  "sgforge-coinvertible": fetchSgForgeCoinvertibleReserves,
  "solstice-attestation": fetchSolsticeAttestationReserves,
  "single-asset": fetchSingleAssetReserves,
  "sky-makercore": fetchSkyMakercoreReserves,
  "superstate-liquidity": fetchSuperstateLiquidityReserves,
  tether: fetchTetherReserves,
  "usdgo-transparency": fetchUsdgoTransparencyReserves,
  "usdai-proof-of-reserves": fetchUsdAiProofOfReserves,
  "usd1-bundle-oracle": fetchUsd1BundleOracleReserves,
  "usdd-data-platform": fetchUsddDataPlatformReserves,
};

const ADAPTERS = Object.fromEntries(
  Object.entries(LIVE_RESERVE_ADAPTER_DEFINITIONS).map(([key, definition]) => [
    key,
    (() => {
      const validation = "validation" in definition ? definition.validation : undefined;
      return {
      key,
      fetch: ADAPTER_FNS[key as LiveReserveAdapterKey],
      sourceModel: definition.sourceModel,
      evidenceClass: definition.evidenceClass,
      sharedSourceMode: definition.sharedSourceMode,
      redemptionTelemetry: definition.redemptionTelemetry,
      ...(validation ? { validation } : {}),
    };
    })(),
  ]),
) as Record<LiveReserveAdapterKey, ReserveAdapterDefinition>;

/** Returns the adapter definition for the given key, or null if unknown. */
export function getReserveAdapter(adapterKey: string): ReserveAdapterDefinition | null {
  return ADAPTERS[adapterKey as LiveReserveAdapterKey] ?? null;
}
