import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import { fetchThreeJaneUsd3Reserves } from "./3jane-usd3";
import { fetchAbracadabraReserves } from "./abracadabra";
import { fetchAccountableReserves } from "./accountable";
import { fetchAnzenUsdzReserves } from "./anzen-usdz";
import { fetchAsymmetryReserves } from "./asymmetry";
import { fetchAttestationPdfIndexReserves } from "./attestation-pdf-index";
import { fetchBlastUsdbYieldManagerReserves } from "./blast-usdb-yield-manager";
import { fetchBtcfiReserves } from "./btcfi";
import { fetchCapVaultReserves } from "./cap-vault";
import { fetchCircleReserves } from "./circle-transparency";
import { fetchChainlinkNavCore } from "./chainlink-nav-core";
import { fetchChainlinkPorReserves } from "./chainlink-por";
import { fetchCollateralPositionsApiReserves } from "./collateral-positions-api";
import { fetchCrvUsdReserves } from "./crvusd";
import { fetchCuratedValidatedReserves } from "./curated-validated";
import { fetchDolaInverseReserves } from "./dola-inverse";
import { fetchEvmBranchBalancesReserves } from "./evm-branch-balances";
import { fetchEthenaReserves } from "./ethena";
import { fetchFalconReserves } from "./falcon";
import { fetchFdusdTransparencyReserves } from "./fdusd-transparency";
import { fetchFraxBalanceSheetReserves, fetchFraxFpiCollateralReserves } from "./frax";
import { fetchFxReserves } from "./fx";
import { fetchGhoReserves } from "./gho";
import { fetchInfiniFiReserves } from "./infinifi";
import { fetchJupUsdReserves } from "./jupusd";
import { fetchListaReserves } from "./lista";
import { fetchLiquityV1Reserves } from "./liquity-v1";
import { fetchLiquityNativeActivePoolReserves } from "./liquity-native-active-pool";
import { fetchLiquityV2BranchReserves } from "./liquity-v2-branches";
import { fetchM0Reserves } from "./m0";
import { fetchM0WrapperUnderlyingReserves } from "./m0-wrapper-underlying";
import { fetchMentoReserves } from "./mento";
import { fetchNestVaultPositionsReserves } from "./nest-vault-positions";
import { fetchOpenEdenUsdoReserves } from "./openeden";
import { fetchOriginVaultBalancesReserves } from "./origin-vault-balances";
import { fetchPusdVaultReserves } from "./pusd-vault";
import { fetchQuantozTransparencyReserves } from "./quantoz-transparency";
import { fetchReMetricsReserves } from "./re-metrics";
import { fetchResupplyPairsReserves } from "./resupply-pairs";
import { fetchReserveProtocolDtfReserves } from "./reserve-protocol-dtf";
import { fetchReservoirReserves } from "./reservoir";
import { fetchRippleTransparencyReserves } from "./ripple-transparency";
import { fetchRiverProtocolInfoReserves } from "./river-protocol-info";
import { fetchErc4626SingleAssetReserves } from "./erc4626-single-asset";
import { fetchSgForgeCoinvertibleReserves } from "./sgforge-coinvertible";
import { fetchSghoWrapperReserves } from "./sgho-wrapper";
import { fetchSingleAssetReserves } from "./single-asset";
import { fetchSkyMakercoreReserves } from "./sky-makercore";
import { fetchSolsticeAttestationReserves } from "./solstice-attestation";
import { fetchSpikoApiReserves } from "./spiko-api";
import { fetchSuperstateLiquidityReserves } from "./superstate-liquidity";
import { fetchTetherTransparencyReserves } from "./tether-transparency";
import { fetchUnitedPorReserves } from "./united-por";
import { fetchUsdgoTransparencyReserves } from "./usdgo-transparency";
import { fetchUsdhNativeMarketsReserves } from "./usdh-native-markets";
import { fetchUsdAiProofOfReserves } from "./usdai-proof-of-reserves";
import { fetchUsd1BundleOracleReserves } from "./usd1-bundle-oracle";
import { fetchUsddDataPlatformReserves } from "./usdd-data-platform";
import { fetchUsdtbTransparencyReserves } from "./usdtb-transparency";
import { fetchYamatoReserves } from "./yamato";
import { fetchZephyrScannerReserves } from "./zephyr-scanner";
import type { AdapterFn, ReserveAdapterDefinition } from "./types";

export type { AdapterContext, AdapterResult, AdapterFn, ReserveAdapterDefinition } from "./types";

export const LIVE_RESERVE_ADAPTER_FETCHERS = {
  "3jane-usd3": fetchThreeJaneUsd3Reserves,
  abracadabra: fetchAbracadabraReserves,
  accountable: fetchAccountableReserves,
  "anzen-usdz": fetchAnzenUsdzReserves,
  asymmetry: fetchAsymmetryReserves,
  "attestation-pdf-index": fetchAttestationPdfIndexReserves,
  "blast-usdb-yield-manager": fetchBlastUsdbYieldManagerReserves,
  btcfi: fetchBtcfiReserves,
  "cap-vault": fetchCapVaultReserves,
  "chainlink-nav": fetchChainlinkNavCore,
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
  "frax-fpi-collateral": fetchFraxFpiCollateralReserves,
  fx: fetchFxReserves,
  gho: fetchGhoReserves,
  infinifi: fetchInfiniFiReserves,
  jupusd: fetchJupUsdReserves,
  lista: fetchListaReserves,
  "liquity-v1": fetchLiquityV1Reserves,
  "liquity-native-active-pool": fetchLiquityNativeActivePoolReserves,
  "liquity-v2-branches": fetchLiquityV2BranchReserves,
  m0: fetchM0Reserves,
  "m0-wrapper-underlying": fetchM0WrapperUnderlyingReserves,
  mento: fetchMentoReserves,
  "nest-vault-positions": fetchNestVaultPositionsReserves,
  "openeden-usdo": fetchOpenEdenUsdoReserves,
  "origin-vault-balances": fetchOriginVaultBalancesReserves,
  "pusd-vault": fetchPusdVaultReserves,
  "quantoz-transparency": fetchQuantozTransparencyReserves,
  "re-metrics": fetchReMetricsReserves,
  "resupply-pairs": fetchResupplyPairsReserves,
  "reserve-protocol-dtf": fetchReserveProtocolDtfReserves,
  reservoir: fetchReservoirReserves,
  "ripple-transparency": fetchRippleTransparencyReserves,
  "river-protocol-info": fetchRiverProtocolInfoReserves,
  "sgforge-coinvertible": fetchSgForgeCoinvertibleReserves,
  "sgho-wrapper": fetchSghoWrapperReserves,
  "solstice-attestation": fetchSolsticeAttestationReserves,
  "single-asset": fetchSingleAssetReserves,
  "sky-makercore": fetchSkyMakercoreReserves,
  "spiko-api": fetchSpikoApiReserves,
  "superstate-liquidity": fetchSuperstateLiquidityReserves,
  "tether-transparency": fetchTetherTransparencyReserves,
  "united-por": fetchUnitedPorReserves,
  "usdgo-transparency": fetchUsdgoTransparencyReserves,
  "usdh-native-markets": fetchUsdhNativeMarketsReserves,
  "usdai-proof-of-reserves": fetchUsdAiProofOfReserves,
  "usd1-bundle-oracle": fetchUsd1BundleOracleReserves,
  "usdd-data-platform": fetchUsddDataPlatformReserves,
  "usdtb-transparency": fetchUsdtbTransparencyReserves,
  yamato: fetchYamatoReserves,
  "zephyr-scanner": fetchZephyrScannerReserves,
} satisfies Record<LiveReserveAdapterKey, AdapterFn>;

// Cast (not satisfies) below: Object.fromEntries widens keys to string, so the
// adapter-key map type must be re-asserted; key coverage is enforced by the
// LIVE_RESERVE_ADAPTER_FETCHERS `satisfies` check and the registry test.
const ADAPTERS = Object.fromEntries(
  Object.entries(LIVE_RESERVE_ADAPTER_DEFINITIONS).map(([key, definition]) => [
    key,
    (() => {
      const validation = "validation" in definition ? definition.validation : undefined;
      return {
        key,
        fetch: LIVE_RESERVE_ADAPTER_FETCHERS[key as LiveReserveAdapterKey],
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
