import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import { fetchThreeJaneUsd3Reserves } from "./3jane-usd3";
import { fetchAbracadabraReserves } from "./abracadabra";
import { fetchAccountableReserves } from "./accountable";
import { fetchAgoraIndependentAssuranceReserves } from "./agora-independent-assurance";
import { fetchAnzenUsdzReserves } from "./anzen-usdz";
import { fetchAnchorageIndependentAssuranceReserves } from "./anchorage-independent-assurance";
import { fetchAsymmetryReserves } from "./asymmetry";
import { fetchAttestationPdfIndexReserves } from "./attestation-pdf-index";
import { fetchAuddIndependentAssuranceReserves } from "./audd-independent-assurance";
import { fetchBrlaIndependentAssuranceReserves } from "./brla-independent-assurance";
import { fetchCaddIndependentAssuranceReserves } from "./cadd-independent-assurance";
import { fetchPaxosIndependentAssuranceReserves } from "./paxos-independent-assurance";
import { fetchIndependentAssuranceAdapter } from "./independent-assurance";
import { fetchBlastUsdbYieldManagerReserves } from "./blast-usdb-yield-manager";
import { fetchBridgeTransparencyReserves } from "./bridge-transparency";
import { fetchBtcfiReserves } from "./btcfi";
import { fetchCapVaultReserves } from "./cap-vault";
import { fetchCircleReserves } from "./circle-transparency";
import { fetchChainlinkNavCore } from "./chainlink-nav-core";
import { fetchChainlinkPorReserves } from "./chainlink-por";
import { fetchChronicleNavReserves } from "./chronicle-nav";
import { fetchCollateralPositionsApiReserves } from "./collateral-positions-api";
import { fetchCrvUsdReserves } from "./crvusd";
import { fetchCuratedValidatedReserves } from "./curated-validated";
import { fetchDolaInverseReserves } from "./dola-inverse";
import { fetchEscrowBalanceReserves } from "./escrow-balance";
import { fetchEvmBranchBalancesReserves } from "./evm-branch-balances";
import { fetchEthenaReserves } from "./ethena";
import { fetchEthenaWhitelabelReserves } from "./ethena-whitelabel";
import { fetchFalconReserves } from "./falcon";
import { fetchFdusdIndependentAssuranceReserves } from "./fdusd-independent-assurance";
import { fetchFdusdTransparencyReserves } from "./fdusd-transparency";
import { fetchFiddIndependentAssuranceReserves } from "./fidd-independent-assurance";
import { fetchFlyingTulipFtUsdReserves } from "./flying-tulip-ftusd";
import { fetchFraxBalanceSheetReserves, fetchFraxFpiCollateralReserves } from "./frax";
import { fetchFxReserves } from "./fx";
import { fetchGeminiIndependentAssuranceReserves } from "./gemini-independent-assurance";
import { fetchGhoReserves } from "./gho";
import { fetchHiveHbdProtocolReserves } from "./hive-hbd-protocol";
import { fetchIdleCdoEpochVariantReserves } from "./idle-cdo-epoch-variant";
import { fetchInfiniFiReserves } from "./infinifi";
import { fetchJupUsdReserves } from "./jupusd";
import { fetchKavaCdpReserves } from "./kava-cdp";
import { fetchKrwqCustodianReserves } from "./krwq-custodian";
import { fetchListaReserves } from "./lista";
import { fetchLiquityV1Reserves } from "./liquity-v1";
import { fetchLiquityNativeActivePoolReserves } from "./liquity-native-active-pool";
import { fetchLiquityV2BranchReserves } from "./liquity-v2-branches";
import { fetchM0Reserves } from "./m0";
import { fetchM0WrapperUnderlyingReserves } from "./m0-wrapper-underlying";
import { fetchMakinaStrategyReserves } from "./makina-strategy";
import { fetchMegausdCustodyReserves } from "./megausd-custody";
import { fetchMentoReserves } from "./mento";
import { fetchMocDocReserves } from "./moc-doc";
import { fetchUsdrifRifReserves } from "./usdrif-rif";
import { fetchNestVaultPositionsReserves } from "./nest-vault-positions";
import { fetchOpenEdenUsdoReserves } from "./openeden";
import { fetchOriginVaultBalancesReserves } from "./origin-vault-balances";
import { fetchParallelizerBalancesReserves } from "./parallelizer-balances";
import { fetchPusdVaultReserves } from "./pusd-vault";
import { fetchQuantozTransparencyReserves } from "./quantoz-transparency";
import { fetchReMetricsReserves } from "./re-metrics";
import { fetchResupplyPairsReserves } from "./resupply-pairs";
import { fetchSaturnPyusdxReserves } from "./saturn-pyusdx";
import { fetchSbcIndependentAssuranceReserves } from "./sbc-independent-assurance";
import { fetchReserveProtocolDtfReserves } from "./reserve-protocol-dtf";
import { fetchReservoirReserves } from "./reservoir";
import { fetchRippleTransparencyReserves } from "./ripple-transparency";
import { fetchRiverProtocolInfoReserves } from "./river-protocol-info";
import { fetchErc4626SingleAssetReserves } from "./erc4626-single-asset";
import { fetchAstherusEarnWrapperReserves } from "./astherus-earn-wrapper";
import { fetchInitiaWrapperVaultReserves } from "./initia-wrapper-vault";
import { fetchStoneyieldRouterPoolReserves } from "./stoneyield-router-pool";
import { fetchSgForgeCoinvertibleReserves } from "./sgforge-coinvertible";
import { fetchSghoWrapperReserves } from "./sgho-wrapper";
import { fetchSingleAssetReserves } from "./single-asset";
import { fetchSkyMakercoreReserves } from "./sky-makercore";
import { fetchSolomonProtocolReserves } from "./solomon-protocol";

import { fetchSolsticeAttestationReserves } from "./solstice-attestation";
import { fetchSpikoApiReserves } from "./spiko-api";
import { fetchSuperstateLiquidityReserves } from "./superstate-liquidity";
import { fetchTetherTransparencyReserves } from "./tether-transparency";
import { fetchUnitedPorReserves } from "./united-por";
import { fetchUsdgoTransparencyReserves } from "./usdgo-transparency";
import { fetchUsdhNativeMarketsReserves } from "./usdh-native-markets";
import { fetchUsdAiProofOfReserves } from "./usdai-proof-of-reserves";
import { fetchUsdaiHubReserves } from "./usdai-hub";
import { fetchUsd1BundleOracleReserves } from "./usd1-bundle-oracle";
import { fetchUsddDataPlatformReserves } from "./usdd-data-platform";
import { fetchUsdtbTransparencyReserves } from "./usdtb-transparency";
import { fetchYamatoReserves } from "./yamato";
import { fetchXdaiBridgeReserves } from "./xdai-bridge";
import { fetchXprAccountBalancesReserves } from "./xpr-account-balances";
import { fetchZephyrScannerReserves } from "./zephyr-scanner";
import type { AdapterFn, ReserveAdapterDefinition } from "./types";

export type { AdapterContext, AdapterResult, AdapterFn, ReserveAdapterDefinition } from "./types";

export const LIVE_RESERVE_ADAPTER_FETCHERS = {
  "3jane-usd3": fetchThreeJaneUsd3Reserves,
  abracadabra: fetchAbracadabraReserves,
  accountable: fetchAccountableReserves,
  "agora-independent-assurance": fetchAgoraIndependentAssuranceReserves,
  "anchorage-independent-assurance": fetchAnchorageIndependentAssuranceReserves,
  "anzen-usdz": fetchAnzenUsdzReserves,
  "astherus-earn-wrapper": fetchAstherusEarnWrapperReserves,
  asymmetry: fetchAsymmetryReserves,
  "attestation-pdf-index": fetchAttestationPdfIndexReserves,
  "audd-independent-assurance": fetchAuddIndependentAssuranceReserves,
  "audx-independent-assurance": fetchIndependentAssuranceAdapter,
  "blast-usdb-yield-manager": fetchBlastUsdbYieldManagerReserves,
  "brla-independent-assurance": fetchBrlaIndependentAssuranceReserves,
  "bridge-transparency": fetchBridgeTransparencyReserves,
  btcfi: fetchBtcfiReserves,
  "cadd-independent-assurance": fetchCaddIndependentAssuranceReserves,
  "cap-vault": fetchCapVaultReserves,
  "chainlink-nav": fetchChainlinkNavCore,
  "circle-transparency": fetchCircleReserves,
  "chainlink-por": fetchChainlinkPorReserves,
  "chronicle-nav": fetchChronicleNavReserves,
  "collateral-positions-api": fetchCollateralPositionsApiReserves,
  crvusd: fetchCrvUsdReserves,
  "curated-validated": fetchCuratedValidatedReserves,
  "dola-inverse": fetchDolaInverseReserves,
  "erc4626-single-asset": fetchErc4626SingleAssetReserves,
  "escrow-balance": fetchEscrowBalanceReserves,
  ethena: fetchEthenaReserves,
  "ethena-whitelabel": fetchEthenaWhitelabelReserves,
  "europ-independent-assurance": fetchIndependentAssuranceAdapter,
  "evm-branch-balances": fetchEvmBranchBalancesReserves,
  falcon: fetchFalconReserves,
  "fdusd-independent-assurance": fetchFdusdIndependentAssuranceReserves,
  "fdusd-transparency": fetchFdusdTransparencyReserves,
  "fidd-independent-assurance": fetchFiddIndependentAssuranceReserves,
  "flying-tulip-ftusd": fetchFlyingTulipFtUsdReserves,
  "frax-balance-sheet": fetchFraxBalanceSheetReserves,
  "frax-fpi-collateral": fetchFraxFpiCollateralReserves,
  fx: fetchFxReserves,
  "gemini-independent-assurance": fetchGeminiIndependentAssuranceReserves,
  gho: fetchGhoReserves,
  "hive-hbd-protocol": fetchHiveHbdProtocolReserves,
  "idle-cdo-epoch-variant": fetchIdleCdoEpochVariantReserves,
  infinifi: fetchInfiniFiReserves,
  "initia-wrapper-vault": fetchInitiaWrapperVaultReserves,
  "issuer-attested-report": fetchIndependentAssuranceAdapter,
  jupusd: fetchJupUsdReserves,
  "kava-cdp": fetchKavaCdpReserves,
  "krwq-custodian": fetchKrwqCustodianReserves,
  lista: fetchListaReserves,
  "liquity-v1": fetchLiquityV1Reserves,
  "liquity-native-active-pool": fetchLiquityNativeActivePoolReserves,
  "liquity-v2-branches": fetchLiquityV2BranchReserves,
  m0: fetchM0Reserves,
  "m0-wrapper-underlying": fetchM0WrapperUnderlyingReserves,
  "makina-strategy": fetchMakinaStrategyReserves,
  "megausd-custody": fetchMegausdCustodyReserves,
  mento: fetchMentoReserves,
  "moc-doc": fetchMocDocReserves,
  "moc-v3-buckets": fetchUsdrifRifReserves,
  "nest-vault-positions": fetchNestVaultPositionsReserves,
  "openeden-usdo": fetchOpenEdenUsdoReserves,
  "origin-vault-balances": fetchOriginVaultBalancesReserves,
  "parallelizer-balances": fetchParallelizerBalancesReserves,
  "pusd-vault": fetchPusdVaultReserves,
  "quantoz-transparency": fetchQuantozTransparencyReserves,
  "re-metrics": fetchReMetricsReserves,
  "resupply-pairs": fetchResupplyPairsReserves,
  "saturn-pyusdx": fetchSaturnPyusdxReserves,
  "sbc-independent-assurance": fetchSbcIndependentAssuranceReserves,
  "reserve-protocol-dtf": fetchReserveProtocolDtfReserves,
  reservoir: fetchReservoirReserves,
  "ripple-transparency": fetchRippleTransparencyReserves,
  "river-protocol-info": fetchRiverProtocolInfoReserves,
  "sgforge-coinvertible": fetchSgForgeCoinvertibleReserves,
  "sgho-wrapper": fetchSghoWrapperReserves,
  "solstice-attestation": fetchSolsticeAttestationReserves,
  "single-asset": fetchSingleAssetReserves,
  "sky-makercore": fetchSkyMakercoreReserves,
  "solomon-protocol": fetchSolomonProtocolReserves,

  "spiko-api": fetchSpikoApiReserves,
  "stoneyield-router-pool": fetchStoneyieldRouterPoolReserves,
  "superstate-liquidity": fetchSuperstateLiquidityReserves,
  "paxos-independent-assurance": fetchPaxosIndependentAssuranceReserves,
  "straitsx-independent-assurance": fetchIndependentAssuranceAdapter,
  "tether-transparency": fetchTetherTransparencyReserves,
  "united-por": fetchUnitedPorReserves,
  "usdgo-transparency": fetchUsdgoTransparencyReserves,
  "usdh-native-markets": fetchUsdhNativeMarketsReserves,
  "usdai-proof-of-reserves": fetchUsdAiProofOfReserves,
  "usdai-hub": fetchUsdaiHubReserves,
  "usd1-bundle-oracle": fetchUsd1BundleOracleReserves,
  "usdd-data-platform": fetchUsddDataPlatformReserves,
  "usdtb-transparency": fetchUsdtbTransparencyReserves,
  "xdai-bridge": fetchXdaiBridgeReserves,
  "xpr-account-balances": fetchXprAccountBalancesReserves,
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
