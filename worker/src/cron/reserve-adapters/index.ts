import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import { fetchThreeJaneUsd3Reserves } from "./3jane-usd3";
import { fetchHyloSolanaReserves } from "./hylo-solana";
import { fetchAbracadabraReserves } from "./abracadabra";
import { fetchAccountableReserves } from "./accountable";
import { fetchAgoraIndependentAssuranceReserves } from "./agora-independent-assurance";
import { fetchAnzenUsdzReserves } from "./anzen-usdz";
import { fetchAnchorageIndependentAssuranceReserves } from "./anchorage-independent-assurance";
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
import { fetchDgldGoldMapperReserves } from "./dgld-gold-mapper";
import { fetchDjedCardanoReserves } from "./djed-cardano";
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
import { fetchSodaxSonicReserves } from "./sodax-sonic";
import { fetchHiveHbdProtocolReserves } from "./hive-hbd-protocol";
import { fetchHliquityHederaReserves } from "./hliquity-hedera";
import { fetchIdleCdoEpochVariantReserves } from "./idle-cdo-epoch-variant";
import { fetchIcpGldtReserves } from "./icp-gldt";
import { fetchInfiniFiReserves } from "./infinifi";
import { fetchJupUsdReserves } from "./jupusd";
import { fetchKavaCdpReserves } from "./kava-cdp";
import { fetchKerneSignedPorReserves } from "./kerne-signed-por";
import { fetchKrwqCustodianReserves } from "./krwq-custodian";
import { fetchLiquityV1Reserves } from "./liquity-v1";
import { fetchLiquityNativeActivePoolReserves } from "./liquity-native-active-pool";
import { fetchLiquityV2BranchReserves } from "./liquity-v2-branches";
import { fetchM0Reserves } from "./m0";
import { fetchM0WrapperUnderlyingReserves } from "./m0-wrapper-underlying";
import { fetchMakinaStrategyReserves } from "./makina-strategy";
import { fetchMatrixdockFrsReserves } from "./matrixdock-frs";
import { fetchMegausdCustodyReserves } from "./megausd-custody";
import { fetchMentoReserves } from "./mento";
import { fetchMocDocReserves } from "./moc-doc";
import { fetchMoneyReserves } from "./money-llamma";
import { fetchUsdrifRifReserves } from "./usdrif-rif";
import { fetchNestVaultPositionsReserves } from "./nest-vault-positions";
import { fetchOpenEdenUsdoReserves } from "./openeden";
import { fetchOriginVaultBalancesReserves } from "./origin-vault-balances";
import { fetchParallelizerBalancesReserves } from "./parallelizer-balances";
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
import { fetchUsdyHoldingsReserves } from "./usdy-holdings-report";

import { fetchYamatoReserves } from "./yamato";
import { fetchYouvesTezosReserves } from "./youves-tezos";
import { fetchXdaiBridgeReserves } from "./xdai-bridge";
import { fetchXprAccountBalancesReserves } from "./xpr-account-balances";
import { fetchZephyrScannerReserves } from "./zephyr-scanner";
import { fetchOnreHoldingsCsvReserves } from "./onre-holdings-csv";
import { fetchAvantReservesApiReserves } from "./avant-reserves-api";
import { fetchAfiProofReserves } from "./afi-proof";
import type { AdapterFn, ReserveAdapterDefinition } from "./types";

export type { AdapterContext, AdapterResult, AdapterFn, ReserveAdapterDefinition } from "./types";

// Annotated (not `satisfies`): the explicit `Record<LiveReserveAdapterKey, …>`
// makes a declaration key with no fetcher a compile error here, so the
// declaration table stays the single source of adapter identity.
export const LIVE_RESERVE_ADAPTER_FETCHERS: Record<LiveReserveAdapterKey, AdapterFn> = {
  "hylo-solana": fetchHyloSolanaReserves,
  "usdy-holdings-report": fetchUsdyHoldingsReserves,
  "3jane-usd3": fetchThreeJaneUsd3Reserves,
  abracadabra: fetchAbracadabraReserves,
  accountable: fetchAccountableReserves,
  "agora-independent-assurance": fetchAgoraIndependentAssuranceReserves,
  "anchorage-independent-assurance": fetchAnchorageIndependentAssuranceReserves,
  "anzen-usdz": fetchAnzenUsdzReserves,
  "astherus-earn-wrapper": fetchAstherusEarnWrapperReserves,
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
  "dgld-gold-mapper": fetchDgldGoldMapperReserves,
  "djed-cardano": fetchDjedCardanoReserves,
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
  "sodax-sonic": fetchSodaxSonicReserves,
  "hive-hbd-protocol": fetchHiveHbdProtocolReserves,
  "hliquity-hedera": fetchHliquityHederaReserves,
  "idle-cdo-epoch-variant": fetchIdleCdoEpochVariantReserves,
  "icp-gldt": fetchIcpGldtReserves,
  infinifi: fetchInfiniFiReserves,
  "initia-wrapper-vault": fetchInitiaWrapperVaultReserves,
  "issuer-attested-report": fetchIndependentAssuranceAdapter,
  jupusd: fetchJupUsdReserves,
  "kava-cdp": fetchKavaCdpReserves,
  "kerne-signed-por": fetchKerneSignedPorReserves,
  "krwq-custodian": fetchKrwqCustodianReserves,
  "liquity-v1": fetchLiquityV1Reserves,
  "liquity-native-active-pool": fetchLiquityNativeActivePoolReserves,
  "liquity-v2-branches": fetchLiquityV2BranchReserves,
  m0: fetchM0Reserves,
  "m0-wrapper-underlying": fetchM0WrapperUnderlyingReserves,
  "makina-strategy": fetchMakinaStrategyReserves,
  "matrixdock-frs": fetchMatrixdockFrsReserves,
  "megausd-custody": fetchMegausdCustodyReserves,
  mento: fetchMentoReserves,
  "moc-doc": fetchMocDocReserves,
  "moc-v3-buckets": fetchUsdrifRifReserves,
  "money-llamma": fetchMoneyReserves,
  "nest-vault-positions": fetchNestVaultPositionsReserves,
  "openeden-usdo": fetchOpenEdenUsdoReserves,
  "origin-vault-balances": fetchOriginVaultBalancesReserves,
  "parallelizer-balances": fetchParallelizerBalancesReserves,
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
  "youves-tezos": fetchYouvesTezosReserves,
  "zephyr-scanner": fetchZephyrScannerReserves,
  "onre-holdings-csv": fetchOnreHoldingsCsvReserves,
  "avant-reserves-api": fetchAvantReservesApiReserves,
  "afi-proof": fetchAfiProofReserves,
};

// Cast (not satisfies) below: Object.fromEntries widens keys to string, so the
// adapter-key map type must be re-asserted; key coverage is enforced by the
// LIVE_RESERVE_ADAPTER_FETCHERS annotation and the registry test.
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
