import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import type { AdapterFn, ReserveAdapterDefinition } from "./types";

export type { AdapterContext, AdapterResult, AdapterFn, ReserveAdapterDefinition } from "./types";

/** Keep registry inspection cheap; initialize only the adapter actually fetched. */
function lazyAdapter(load: () => Promise<AdapterFn>): AdapterFn {
  return async (...args) => (await load())(...args);
}

// Annotated (not `satisfies`): the explicit `Record<LiveReserveAdapterKey, …>`
// makes a declaration key with no fetcher a compile error here, so the
// declaration table stays the single source of adapter identity.
export const LIVE_RESERVE_ADAPTER_FETCHERS: Record<LiveReserveAdapterKey, AdapterFn> = {
  "spark-usdc-v1-inventory": lazyAdapter(() =>
    import("./spark-usdc-v1-inventory").then((mod) => mod.fetchSparkUsdcV1InventoryReserves)),
  "forest-road-reserve-manager": lazyAdapter(() =>
    import("./forest-road-reserve-manager").then((mod) => mod.fetchForestRoadReserveManagerReserves)),
  "leverup-lvusd": lazyAdapter(() => import("./leverup-lvusd").then((mod) => mod.fetchLeverupLvusdReserves)),
  "hylo-solana": lazyAdapter(() => import("./hylo-solana").then((mod) => mod.fetchHyloSolanaReserves)),
  "3jane-usd3": lazyAdapter(() => import("./3jane-usd3").then((mod) => mod.fetchThreeJaneUsd3Reserves)),
  accountable: lazyAdapter(() => import("./accountable").then((mod) => mod.fetchAccountableReserves)),
  "agora-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "anchorage-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "anzen-usdz": lazyAdapter(() => import("./anzen-usdz").then((mod) => mod.fetchAnzenUsdzReserves)),
  "astherus-earn-wrapper": lazyAdapter(() => import("./astherus-earn-wrapper").then((mod) => mod.fetchAstherusEarnWrapperReserves)),
  "attestation-pdf-index": lazyAdapter(() => import("./attestation-pdf-index").then((mod) => mod.fetchAttestationPdfIndexReserves)),
  "audd-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "audx-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "blast-usdb-yield-manager": lazyAdapter(() => import("./blast-usdb-yield-manager").then((mod) => mod.fetchBlastUsdbYieldManagerReserves)),
  "myrc-independent-assurance": lazyAdapter(() =>
    import("./myrc-independent-assurance").then((mod) => mod.fetchMyrcIndependentAssuranceReserves)),
  "brla-independent-assurance": lazyAdapter(() => import("./brla-independent-assurance").then((mod) => mod.fetchBrlaIndependentAssuranceReserves)),
  "bridge-transparency": lazyAdapter(() => import("./bridge-transparency").then((mod) => mod.fetchBridgeTransparencyReserves)),
  btcfi: lazyAdapter(() => import("./btcfi").then((mod) => mod.fetchBtcfiReserves)),
  "cadd-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "cap-vault": lazyAdapter(() => import("./cap-vault").then((mod) => mod.fetchCapVaultReserves)),
  "chainlink-nav": lazyAdapter(() => import("./chainlink-nav-core").then((mod) => mod.fetchChainlinkNavCore)),
  "jpmorgan-nav": lazyAdapter(() => import("./jpmorgan-nav").then((mod) => mod.fetchJpmorganNavReserves)),
  "circle-transparency": lazyAdapter(() => import("./circle-transparency").then((mod) => mod.fetchCircleReserves)),
  "chainlink-por": lazyAdapter(() => import("./chainlink-por").then((mod) => mod.fetchChainlinkPorReserves)),
  "chronicle-nav": lazyAdapter(() => import("./chronicle-nav").then((mod) => mod.fetchChronicleNavReserves)),
  "collateral-positions-api": lazyAdapter(() => import("./collateral-positions-api").then((mod) => mod.fetchCollateralPositionsApiReserves)),
  crvusd: lazyAdapter(() => import("./crvusd").then((mod) => mod.fetchCrvUsdReserves)),
  "curated-validated": lazyAdapter(() => import("./curated-validated").then((mod) => mod.fetchCuratedValidatedReserves)),
  "dgld-gold-mapper": lazyAdapter(() => import("./dgld-gold-mapper").then((mod) => mod.fetchDgldGoldMapperReserves)),
  "djed-cardano": lazyAdapter(() => import("./djed-cardano").then((mod) => mod.fetchDjedCardanoReserves)),
  "dola-inverse": lazyAdapter(() => import("./dola-inverse").then((mod) => mod.fetchDolaInverseReserves)),
  "erc4626-single-asset": lazyAdapter(() => import("./erc4626-single-asset").then((mod) => mod.fetchErc4626SingleAssetReserves)),
  "escrow-balance": lazyAdapter(() => import("./escrow-balance").then((mod) => mod.fetchEscrowBalanceReserves)),
  ethena: lazyAdapter(() => import("./ethena").then((mod) => mod.fetchEthenaReserves)),
  "ethena-whitelabel": lazyAdapter(() => import("./ethena-whitelabel").then((mod) => mod.fetchEthenaWhitelabelReserves)),
  "europ-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "evm-branch-balances": lazyAdapter(() => import("./evm-branch-balances").then((mod) => mod.fetchEvmBranchBalancesReserves)),
  falcon: lazyAdapter(() => import("./falcon").then((mod) => mod.fetchFalconReserves)),
  "fdusd-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "fidd-independent-assurance": lazyAdapter(() => import("./fidd-independent-assurance").then((mod) => mod.fetchFiddIndependentAssuranceReserves)),
  "flying-tulip-ftusd": lazyAdapter(() => import("./flying-tulip-ftusd").then((mod) => mod.fetchFlyingTulipFtUsdReserves)),
  "frax-balance-sheet": lazyAdapter(() => import("./frax").then((mod) => mod.fetchFraxBalanceSheetReserves)),
  "frax-fpi-collateral": lazyAdapter(() => import("./frax").then((mod) => mod.fetchFraxFpiCollateralReserves)),
  fx: lazyAdapter(() => import("./fx").then((mod) => mod.fetchFxReserves)),
  "gemini-independent-assurance": lazyAdapter(() => import("./gemini-independent-assurance").then((mod) => mod.fetchGeminiIndependentAssuranceReserves)),
  gho: lazyAdapter(() => import("./gho").then((mod) => mod.fetchGhoReserves)),
  "sodax-sonic": lazyAdapter(() => import("./sodax-sonic").then((mod) => mod.fetchSodaxSonicReserves)),
  "hive-hbd-protocol": lazyAdapter(() => import("./hive-hbd-protocol").then((mod) => mod.fetchHiveHbdProtocolReserves)),
  "hliquity-hedera": lazyAdapter(() => import("./hliquity-hedera").then((mod) => mod.fetchHliquityHederaReserves)),
  "idle-cdo-epoch-variant": lazyAdapter(() => import("./idle-cdo-epoch-variant").then((mod) => mod.fetchIdleCdoEpochVariantReserves)),
  "icp-gldt": lazyAdapter(() => import("./icp-gldt").then((mod) => mod.fetchIcpGldtReserves)),
  infinifi: lazyAdapter(() => import("./infinifi").then((mod) => mod.fetchInfiniFiReserves)),
  "initia-wrapper-vault": lazyAdapter(() => import("./initia-wrapper-vault").then((mod) => mod.fetchInitiaWrapperVaultReserves)),
  "issuer-attested-report": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  jupusd: lazyAdapter(() => import("./jupusd").then((mod) => mod.fetchJupUsdReserves)),
  "kava-cdp": lazyAdapter(() => import("./kava-cdp").then((mod) => mod.fetchKavaCdpReserves)),
  "kerne-signed-por": lazyAdapter(() => import("./kerne-signed-por").then((mod) => mod.fetchKerneSignedPorReserves)),
  "krwq-custodian": lazyAdapter(() => import("./krwq-custodian").then((mod) => mod.fetchKrwqCustodianReserves)),
  "liquity-v1": lazyAdapter(() => import("./liquity-v1").then((mod) => mod.fetchLiquityV1Reserves)),
  "liquity-native-active-pool": lazyAdapter(() => import("./liquity-native-active-pool").then((mod) => mod.fetchLiquityNativeActivePoolReserves)),
  "liquity-v2-branches": lazyAdapter(() => import("./liquity-v2-branches").then((mod) => mod.fetchLiquityV2BranchReserves)),
  m0: lazyAdapter(() => import("./m0").then((mod) => mod.fetchM0Reserves)),
  "m0-wrapper-underlying": lazyAdapter(() => import("./m0-wrapper-underlying").then((mod) => mod.fetchM0WrapperUnderlyingReserves)),
  "makina-strategy": lazyAdapter(() => import("./makina-strategy").then((mod) => mod.fetchMakinaStrategyReserves)),
  "matrixdock-frs": lazyAdapter(() => import("./matrixdock-frs").then((mod) => mod.fetchMatrixdockFrsReserves)),
  "megausd-custody": lazyAdapter(() => import("./megausd-custody").then((mod) => mod.fetchMegausdCustodyReserves)),
  mento: lazyAdapter(() => import("./mento").then((mod) => mod.fetchMentoReserves)),
  "moc-doc": lazyAdapter(() => import("./moc-doc").then((mod) => mod.fetchMocDocReserves)),
  "moc-v3-buckets": lazyAdapter(() => import("./usdrif-rif").then((mod) => mod.fetchUsdrifRifReserves)),
  "money-llamma": lazyAdapter(() => import("./money-llamma").then((mod) => mod.fetchMoneyReserves)),
  "nest-vault-positions": lazyAdapter(() => import("./nest-vault-positions").then((mod) => mod.fetchNestVaultPositionsReserves)),
  "origin-vault-balances": lazyAdapter(() => import("./origin-vault-balances").then((mod) => mod.fetchOriginVaultBalancesReserves)),
  "parallelizer-balances": lazyAdapter(() => import("./parallelizer-balances").then((mod) => mod.fetchParallelizerBalancesReserves)),
  "quantoz-transparency": lazyAdapter(() => import("./quantoz-transparency").then((mod) => mod.fetchQuantozTransparencyReserves)),
  "re-metrics": lazyAdapter(() => import("./re-metrics").then((mod) => mod.fetchReMetricsReserves)),
  "resupply-pairs": lazyAdapter(() => import("./resupply-pairs").then((mod) => mod.fetchResupplyPairsReserves)),
  "saturn-pyusdx": lazyAdapter(() => import("./saturn-pyusdx").then((mod) => mod.fetchSaturnPyusdxReserves)),
  "sbc-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "reserve-protocol-dtf": lazyAdapter(() => import("./reserve-protocol-dtf").then((mod) => mod.fetchReserveProtocolDtfReserves)),
  reservoir: lazyAdapter(() => import("./reservoir").then((mod) => mod.fetchReservoirReserves)),
  "rlusd-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "ondo-ousg": lazyAdapter(() => import("./ondo-ousg").then((mod) => mod.fetchOndoOusgReserves)),
  "midas-mtbill": lazyAdapter(() => import("./midas-mtbill").then((mod) => mod.fetchMidasMtbillReserves)),
  "river-protocol-info": lazyAdapter(() => import("./river-protocol-info").then((mod) => mod.fetchRiverProtocolInfoReserves)),
  "sgforge-coinvertible": lazyAdapter(() => import("./sgforge-coinvertible").then((mod) => mod.fetchSgForgeCoinvertibleReserves)),
  "solstice-attestation": lazyAdapter(() => import("./solstice-attestation").then((mod) => mod.fetchSolsticeAttestationReserves)),
  "single-asset": lazyAdapter(() => import("./single-asset").then((mod) => mod.fetchSingleAssetReserves)),
  "sky-makercore": lazyAdapter(() => import("./sky-makercore").then((mod) => mod.fetchSkyMakercoreReserves)),
  "solomon-chancery": lazyAdapter(() => import("./solomon-chancery").then((mod) => mod.fetchSolomonChanceryReserves)),

  "spiko-api": lazyAdapter(() => import("./spiko-api").then((mod) => mod.fetchSpikoApiReserves)),
  "superstate-liquidity": lazyAdapter(() => import("./superstate-liquidity").then((mod) => mod.fetchSuperstateLiquidityReserves)),
  "theo-thusd-redemption": lazyAdapter(() => import("./theo-thusd-redemption").then((mod) => mod.fetchTheoThusdRedemptionReserves)),
  "paxos-independent-assurance": lazyAdapter(() => import("./paxos-independent-assurance").then((mod) => mod.fetchPaxosIndependentAssuranceReserves)),
  "straitsx-independent-assurance": lazyAdapter(() => import("./independent-assurance").then((mod) => mod.fetchIndependentAssuranceAdapter)),
  "tether-transparency": lazyAdapter(() => import("./tether-transparency").then((mod) => mod.fetchTetherTransparencyReserves)),
  "united-por": lazyAdapter(() => import("./united-por").then((mod) => mod.fetchUnitedPorReserves)),
  "usdgo-transparency": lazyAdapter(() => import("./usdgo-transparency").then((mod) => mod.fetchUsdgoTransparencyReserves)),
  "usdai-proof-of-reserves": lazyAdapter(() => import("./usdai-proof-of-reserves").then((mod) => mod.fetchUsdAiProofOfReserves)),
  "usdai-hub": lazyAdapter(() => import("./usdai-hub").then((mod) => mod.fetchUsdaiHubReserves)),
  "usd1-bundle-oracle": lazyAdapter(() => import("./usd1-bundle-oracle").then((mod) => mod.fetchUsd1BundleOracleReserves)),
  "usdd-data-platform": lazyAdapter(() => import("./usdd-data-platform").then((mod) => mod.fetchUsddDataPlatformReserves)),
  "usdtb-transparency": lazyAdapter(() => import("./usdtb-transparency").then((mod) => mod.fetchUsdtbTransparencyReserves)),
  "xdai-bridge": lazyAdapter(() => import("./xdai-bridge").then((mod) => mod.fetchXdaiBridgeReserves)),
  "xpr-account-balances": lazyAdapter(() => import("./xpr-account-balances").then((mod) => mod.fetchXprAccountBalancesReserves)),
  yamato: lazyAdapter(() => import("./yamato").then((mod) => mod.fetchYamatoReserves)),
  "youves-tezos": lazyAdapter(() => import("./youves-tezos").then((mod) => mod.fetchYouvesTezosReserves)),
  "zephyr-scanner": lazyAdapter(() => import("./zephyr-scanner").then((mod) => mod.fetchZephyrScannerReserves)),
  "onre-holdings-csv": lazyAdapter(() => import("./onre-holdings-csv").then((mod) => mod.fetchOnreHoldingsCsvReserves)),
  "avant-reserves-api": lazyAdapter(() => import("./avant-reserves-api").then((mod) => mod.fetchAvantReservesApiReserves)),
  "afi-proof": lazyAdapter(() => import("./afi-proof").then((mod) => mod.fetchAfiProofReserves)),
  "frnt-ledgerlens": lazyAdapter(() => import("./frnt-ledgerlens").then((mod) => mod.fetchFrntLedgerlensReserves)),
  "coinbase-oned-por": lazyAdapter(() => import("./coinbase-oned-por").then((mod) => mod.fetchCoinbaseOnedPorReserves)),
  "blackrock-brsrv-holdings": lazyAdapter(() => import("./blackrock-brsrv-holdings").then((mod) => mod.fetchBlackrockBrsrvHoldingsReserves)),
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
