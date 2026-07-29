import type { RedemptionBackstopConfig } from "./shared";
import { defineBackstopRegistry, defineBatch, defineRecordEntries, rebindEntriesToRegistry } from "./factory";
import {
  applyTrackedReviewedDocs,
  collateralRedeemBase,
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  LIQUITY_STYLE_REDEMPTION_FEE,
  sourceRef,
} from "./shared";
import {
  REVIEWED_DIRECT_REDEMPTION_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
  REVIEWED_MAY_BATCH_AT,
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
  REVIEWED_WRAPPER_WAVE_AT,
} from "./review-dates";
const REVIEWED_HIVE_HBD_AT = REVIEWED_MAY_BATCH_AT;
// Mento redemption batch: 13 coins' live reserve sync now reads direct
// on-chain redemption telemetry (Broker/BiPoolManager pools, the GBPm
// Liquity-v2-fork CDP, or the JPYm/CHFm FPMM pools), so their capacity model
// moves from documented-bound to reserve-sync-metadata.
const REVIEWED_MENTO_LIVE_REDEMPTION_AT = "2026-07-09";
const REVIEWED_REDEMPTION_OUTPUTS_AT = "2026-07-15";
const REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT = "2026-07-19";
const MENTO_BIPOOLMANAGER_DOC = sourceRef(
  "Mento BiPoolManager smart-contract docs",
  "https://docs.mento.org/mento/build-on-mento/smart-contracts/bipoolmanager",
  ["route", "capacity", "fees"],
);
const MENTO_V3_DOC = sourceRef("Mento V3 docs", "https://docs.mento.org/mento-v3", ["route"]);
const MENTO_V3_FPMM_DOC = sourceRef("Mento V3 FPMM mechanics", "https://docs.mento.org/mento-v3/dive-deeper/fpmm", [
  "route",
  "capacity",
  "fees",
  "settlement",
]);
const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(REVIEWED_DIRECT_REDEMPTION_AT);
const SOURCE_FILE_PATH = "shared/lib/redemption-backstop-configs/collateral-redeem.ts";
const BASE_COLLATERAL_REDEEM_IDS = [
  "bold-liquity",
  "lusd-liquity",
  "feusd-felix",
  "meusd-mezo",
  "nect-beraborrow",
  "fxusd-f-x-protocol",
  "usdq-quill",
] as const;
const BASE_COLLATERAL_OVERRIDE_REASON =
  "Reviewed collateral-specific route replaces the shared collateral redemption default.";
const BASE_COLLATERAL_REDEEM_ID_SET = new Set<string>(BASE_COLLATERAL_REDEEM_IDS);

function defineCollateralRecordEntries(configs: Record<string, RedemptionBackstopConfig>) {
  return defineRecordEntries(configs, {
    overrideReasonForIds: (id) => (BASE_COLLATERAL_REDEEM_ID_SET.has(id) ? BASE_COLLATERAL_OVERRIDE_REASON : undefined),
    sourceFilePath: SOURCE_FILE_PATH,
  });
}

// JPYm/CHFm: live telemetry now reads the coin's Mento V3 FPMM pool USDm
// balance as direct redemption capacity; the underlying CDP fee mechanics
// (and its costModel) are unchanged, per reviewed docs.
const mentoFpmmPoolRedeemConfig: RedemptionBackstopConfig = {
  ...collateralRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata" },
  reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
  outputAssetType: "stable-single",
  outputAssets: ["cusd-celo"],
  costModel: undisclosedReviewedFee(
    "Mento CDP redemption/repayment path burns the FX stablecoin against USDm collateral at oracle value; public docs reviewed do not publish one global fixed redemption fee",
  ),
  docs: [
    sourceRef("Mento V3 reserve docs", "https://docs.mento.org/mento-v3/dive-deeper/the-reserve", [
      "route",
      "capacity",
      "access",
    ]),
    sourceRef("Getting Mento stables on Celo", "https://docs.mento.org/mento-v3/other/getting-mento-stables/on-celo", [
      "route",
      "fees",
      "settlement",
      "access",
    ]),
    sourceRef("Mento reserve dashboard", "https://reserve.mento.org/", ["capacity", "fees", "settlement"]),
    MENTO_V3_DOC,
  ],
  notes: [
    "Mento CDP-backed FX stables are modeled as on-chain collateral redemptions into USDm collateral rather than issuer fiat redemption.",
    "Live reserve sync now reads the coin's Mento V3 FPMM pool USDm balance each run and reports it as direct redemption capacity, replacing the prior documented-bound/eventual-only model; no live fee telemetry is available for this pool shape.",
    "Output declared 2026-07-19: Mento V3 CDP docs name USDm as the collateral asset of the FX-stable CDP/FPMM path, so the redemption pays USDm (tracked cusd-celo), mirroring the jpym-mento precedent; declaration was previously blocked on cusd-celo being untracked.",
  ],
};

// cUSD (USDm), cEUR (EURm), and the 8 local-FX stables all redeem through a
// Mento Broker/BiPoolManager pool against a stable or USDm counter asset.
const mentoBrokerPoolRedeemConfig: RedemptionBackstopConfig = {
  ...collateralRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata" },
  reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
  outputAssetType: "stable-single",
  outputAssets: ["cusd-celo"],
  costModel: documentedVariableFee(
    "Mento broker pool spread, set on-chain per pool (PoolConfig.spread, currently 5 bps on USDm stable pools per MGP-13); live telemetry supplies the current bps",
    "formula",
  ),
  docs: [
    sourceRef("Mento CDP docs", "https://docs.mento.org/mento-v3/dive-deeper/cdp", [
      "route",
      "capacity",
      "access",
      "settlement",
      "fees",
    ]),
    sourceRef("Mento CDP smart-contract docs", "https://docs.mento.org/mento-v3/build/smart-contracts/cdps", [
      "route",
      "capacity",
      "access",
      "settlement",
      "fees",
    ]),
    sourceRef("Mento V3 addresses", "https://docs.mento.org/mento-v3/build/deployments/addresses", ["route", "access"]),
    sourceRef("Mento reserve dashboard", "https://reserve.mento.org/", ["capacity"]),
    MENTO_BIPOOLMANAGER_DOC,
    MENTO_V3_DOC,
  ],
  notes: [
    "Mento V3 docs describe FX stables as USDm-collateralized Liquity v2-style CDP debt, with normal redemptions following the CDP branch mechanics.",
    "FX market-hours gating can temporarily block normal redemptions and close-trove operations; current docs list Friday 21:00 UTC through Sunday 23:00 UTC plus specified holidays.",
    "Live reserve sync now enumerates the coin's Mento Broker/BiPoolManager pool (getExchangeIds/getPoolExchange) each run and reports the current counter-asset bucket depth and pool spread as direct redemption capacity and fee, replacing the prior documented-bound/eventual-only model.",
    "Output declared 2026-07-19: the coin's Broker/BiPoolManager pool pairs the FX stable against USDm (verified on-chain: every FX exchange settles in the USDm token, the rebranded cUSD), so the redemption pays USDm (tracked cusd-celo); declaration was previously blocked on cusd-celo being untracked.",
  ],
};

const COLLATERAL_REDEEM_REGISTRY_ENTRIES = [
  ...defineBatch(BASE_COLLATERAL_REDEEM_IDS, collateralRedeemBase, { sourceFilePath: SOURCE_FILE_PATH }),
  ...defineBatch(
    ["jpym-mento"],
    { ...mentoFpmmPoolRedeemConfig, outputAssets: ["cusd-celo"] },
    {
      sourceFilePath: SOURCE_FILE_PATH,
    },
  ),
  ...defineBatch(["chfm-mento"], mentoFpmmPoolRedeemConfig, {
    sourceFilePath: SOURCE_FILE_PATH,
  }),
  ...defineBatch(
    ["audm-mento", "brlm-mento", "cadm-mento", "copm-mento", "ghsm-mento", "kesm-mento", "zarm-mento"],
    mentoBrokerPoolRedeemConfig,
    { sourceFilePath: SOURCE_FILE_PATH },
  ),
  ...defineCollateralRecordEntries({
    "bold-liquity": {
      ...collateralRedeemBase,
      outputAssets: ["asset:weth", "asset:wsteth", "asset:reth"],
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      reviewedAt: "2026-03-22",
      docs: [
        sourceRef("Liquity V2 redemption docs", "https://docs.liquity.org/v2-faq/redemptions-and-delegation", [
          "route",
          "capacity",
          "fees",
        ]),
        sourceRef("Liquity v2 repository", "https://github.com/liquity/bold", ["route", "capacity", "fees"]),
      ],
      notes: [
        "Fresh live reserve metadata reads Liquity v2 ActivePool branch debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
      ],
    },
    "lusd-liquity": {
      ...collateralRedeemBase,
      outputAssets: ["asset:eth"],
      capacityModel: { kind: "reserve-sync-metadata" },
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      reviewedAt: "2026-03-22",
      docs: [
        sourceRef("Liquity redemption docs", "https://docs.liquity.org/liquity-v1/faq/lusd-redemptions", [
          "route",
          "capacity",
          "fees",
        ]),
        sourceRef("Liquity v1 contract addresses", "https://docs.liquity.org/liquity-v1/documentation/resources", [
          "capacity",
        ]),
      ],
      notes: [
        "Fresh live reserve metadata reads Liquity v1 TroveManager system debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
      ],
    },
    "feusd-felix": {
      ...collateralRedeemBase,
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:whype", "asset:feubtc", "asset:khype", "asset:wsthype"],
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      costModel: fixedFee(0, "Felix docs describe redemption as fee-free"),
    },
    "meusd-mezo": {
      ...collateralRedeemBase,
      outputAssets: ["asset:btc"],
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      costModel: fixedFee(75, "75 bps standard; 0 bps when redeeming against your own debt"),
      docs: [
        sourceRef("Mezo MUSD overview", "https://mezo.org/docs/users/musd/", ["route", "capacity", "fees"]),
        sourceRef("Mezo MUSD redemption guide", "https://mezo.org/docs/developers/musd/musd-redemptions", [
          "route",
          "capacity",
          "fees",
          "access",
        ]),
      ],
      notes: [
        "Fresh live reserve metadata reads Mezo ActivePool debt as the current direct redemption-capacity bound, paired with BTC collateral value, TCR/MCR route status, and the on-chain redemption-rate read.",
      ],
    },
    "nect-beraborrow": {
      ...collateralRedeemBase,
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      docs: [
        sourceRef(
          "Beraborrow NECT peg docs",
          "https://beraborrow.gitbook.io/docs/nect-stablecoin/redemptions/usdnect-peg",
          ["route", "capacity", "fees"],
        ),
      ],
      notes: [
        "Fresh live reserve metadata reads Beraborrow's Liquity v2-style ActivePool branch debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
      ],
    },
    "fxusd-f-x-protocol": {
      ...collateralRedeemBase,
      outputAssets: ["asset:wsteth", "asset:wbtc"],
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      costModel: fixedFee(50, "Protocol docs list a 50 bps redemption fee"),
      docs: [
        sourceRef("f(x) docs", "https://fxprotocol.gitbook.io/fx-docs", ["route", "capacity", "fees"]),
        sourceRef("f(x) app", "https://fx.aladdin.club", ["capacity"]),
      ],
      notes: [
        "Tracked metadata describes direct oracle-priced collateral redemption when fxUSD trades below peg; current model scores that primary onchain redemption rail rather than Curve secondary liquidity",
      ],
    },
    "usdaf-asymmetry": {
      ...collateralRedeemBase,
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      outputAssets: ["asset:wbtc", "asset:tbtc", "asset:susds", "asset:sfrxusd", "asset:scrvusd", "asset:ysybold"],
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
    },
    "usdq-quill": {
      ...collateralRedeemBase,
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      outputAssets: ["asset:weth", "asset:wsteth", "asset:weeth", "asset:scr"],
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
    },
    "cdp-enosys": {
      ...collateralRedeemBase,
      outputAssets: ["asset:fxrp", "asset:wflr"],
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_FOLLOWUP_REMEDIATION_AT,
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      docs: [
        sourceRef(
          "Flare Enosys Loans launch update",
          "https://flare.network/news/enosys-loans-xrp-backed-stablecoin-flare",
          ["route", "capacity", "fees", "access", "settlement"],
        ),
      ],
      notes: [
        "Modeled as a Liquity V2-style collateral redemption route on Flare; lowest-rate troves are redeemed first when CDP trades below peg.",
        "Fresh live reserve metadata reads Enosys ActivePool branch debt and collateral balances on Flare as the current direct redemption-capacity bound.",
      ],
    },
    "ausdt-tether-alloy": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull("2026-04-20"),
      accessModel: "whitelisted-onchain",
      outputAssetType: "bluechip-collateral",
      costModel: fixedFee(
        25,
        "Alloy CMPVault MINT_OPENING_RETURN_FEE() returns 0xfa, which is 25 bps on the contract's 1e5 fee scale; docs identify this parameter as the return fee",
      ),
      docs: [
        sourceRef("Alloy vault docs", "https://docs.alloy.tether.to/alloy-by-tether/alloy-by-tether-vaults", [
          "route",
          "capacity",
        ]),
        sourceRef(
          "Alloy aUSDT mint docs",
          "https://docs.alloy.tether.to/alloy-by-tether/alloy-by-tether-vaults/ausdmnt",
          ["route", "fees"],
        ),
        sourceRef("Alloy Ethereum deployments", "https://dev.alloy.tether.to/deployments/ethereum-mainnet", [
          "capacity",
        ]),
      ],
      notes: [
        "A holder needs Alloy verification and usable CMP collateral access to exercise the onchain return path; route scoring reflects whitelisted collateral redemption rather than public fiat redemption",
        "Live reserve sync reads the current XAUT vault balance and aUSDT total supply, but current redemption capacity is still modeled as documented eventual system redeemability until Alloy exposes per-account/current redeemable-capacity telemetry",
      ],
    },
    "ebusd-ebisu": {
      ...collateralRedeemBase,
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      docs: [
        sourceRef("Ebisu overview", "https://ebisu.gitbook.io/ebisu-money", ["route", "capacity"]),
        sourceRef(
          "Ebisu mainnet deployments",
          "https://ebisu.gitbook.io/ebisu-money/developers/deployment-addresses-mainnet",
          ["capacity"],
        ),
        sourceRef("Liquity V2 redemption fee docs", "https://docs.liquity.org/v2-faq/redemptions-and-delegation", [
          "fees",
        ]),
      ],
      notes: [
        "Fresh live reserve metadata reads Ebisu's Liquity v2-style ActivePool branch debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
        "Redemptions return the collateral of the lowest-rate loans, so the output depends on active collateral branches and position state. No complete fixed output basket is documented; outputAssets intentionally remains unset rather than publishing a tracked subset.",
      ],
    },
    "ussd-sonic-labs": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_REMEDIATION_AT),
      outputAssetType: "stable-single",
      outputAssets: ["frxusd-frax"],
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_AT,
      costModel: fixedFee(0, "The verified Sonic BrandedCustodian returned redeemFee() = 0 at Sonic block 75971769."),
      docs: [
        sourceRef("Sonic USSD docs", "https://docs.soniclabs.com/sonic/ussd", [
          "route",
          "capacity",
          "access",
          "settlement",
        ]),
        sourceRef(
          "USSD BrandedCustodian verified contract",
          "https://sonicscan.org/address/0x54e14489646fd9693ea5071cb5dfeb1f5afa8f03#code",
          ["route", "capacity", "fees", "settlement"],
        ),
        sourceRef("Sonic USSD page", "https://www.soniclabs.com/ussd", ["route", "capacity", "settlement"]),
      ],
      notes: [
        "Sonic's public page describes a broader upstream supported-USD-asset set, but the deployed direct holder route is the USSD BrandedCustodian. At Sonic block 75971769 its custodianTkn() returned Sonic frxUSD (0x80Eede496655FB9047dd39d9f418d5483ED600df).",
      ],
    },
    "reusd-resupply": {
      ...collateralRedeemBase,
      capacityModel: {
        kind: "reserve-sync-metadata",
      },
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:crvusd", "asset:frxusd"],
      costModel: fixedFee(100, "Communal redemption model with 1% fee establishing a price floor"),
      docs: [
        sourceRef("Resupply stability mechanics", "https://docs.resupply.fi/resupply-protocol/stability-mechanics", [
          "route",
          "capacity",
          "fees",
        ]),
        sourceRef(
          "Resupply collateralized debt positions",
          "https://docs.resupply.finance/resupply-protocol/collateralized-debt-positions",
          ["route", "capacity"],
        ),
        sourceRef("Resupply app", "https://resupply.fi/redeem", ["route", "capacity", "settlement"]),
      ],
      notes: [
        "Fresh Resupply pair telemetry reads RedemptionHandler.getMaxRedeemableDebt() and the permissionless guard state as the current executable capacity bound; when the guard is closed, the route stays visible but does not uplift Safety Score liquidity",
        "Output declared 2026-07-19: Resupply docs state all reUSD collateral backing consists of crvUSD supplied to Curve Lend or frxUSD supplied to Frax Lend, and the redeemer chooses which pools to redeem against, so the payout is the chosen pools' crvUSD/frxUSD-denominated lending collateral.",
      ],
    },
    "cusd-celo": {
      ...collateralRedeemBase,
      outputAssets: ["usdc-circle", "usdt-tether"],
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_AT,
      outputAssetType: "stable-basket",
      costModel: documentedVariableFee(
        "Mento broker pool spread, set on-chain per pool (PoolConfig.spread, currently 5 bps on USDm stable pools per MGP-13); live telemetry supplies the current bps",
        "formula",
      ),
      docs: [
        sourceRef("Mento V3 reserve docs", "https://docs.mento.org/mento-v3/dive-deeper/the-reserve", [
          "route",
          "capacity",
        ]),
        sourceRef("Mento reserve dashboard", "https://reserve.mento.org/", ["capacity"]),
        MENTO_BIPOOLMANAGER_DOC,
        MENTO_V3_FPMM_DOC,
        MENTO_V3_DOC,
      ],
      notes: [
        "Mento V3 documents USDm (the tracked cusd-celo asset) as Reserve-backed, while its direct FPMM swap route returns the configured counter asset at the oracle rate minus fees.",
        "Live reserve sync now enumerates USDm's Mento Broker/BiPoolManager pools (getExchangeIds/getPoolExchange) each run, summing the matched USDC/USDT counter-asset bucket depths as direct redemption capacity and reporting the current pool spread as fee.",
      ],
    },
    "ceur-celo": {
      ...collateralRedeemBase,
      outputAssets: ["cusd-celo"],
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_AT,
      outputAssetType: "stable-single",
      costModel: documentedVariableFee(
        "Mento broker pool spread, set on-chain per pool (PoolConfig.spread, currently 5 bps on USDm stable pools per MGP-13); live telemetry supplies the current bps",
        "formula",
      ),
      docs: [
        sourceRef("Mento V3 reserve docs", "https://docs.mento.org/mento-v3/dive-deeper/the-reserve", [
          "route",
          "capacity",
        ]),
        sourceRef("Mento reserve dashboard", "https://reserve.mento.org/", ["capacity"]),
        MENTO_BIPOOLMANAGER_DOC,
        MENTO_V3_FPMM_DOC,
        MENTO_V3_DOC,
      ],
      notes: [
        "Mento V3 documents EURm as Reserve-backed, while the current Celo FPMM direct holder route swaps EURm into USDm (tracked as cusd-celo) at the oracle rate minus fees.",
        "Live reserve sync now enumerates EURm's Mento Broker/BiPoolManager USDm/EURm pool (getExchangeIds/getPoolExchange) each run, reporting the USDm counter-asset bucket depth as direct redemption capacity and the current pool spread as fee.",
      ],
    },
    "gbpm-mento": {
      ...collateralRedeemBase,
      outputAssets: ["cusd-celo"],
      capacityModel: { kind: "reserve-sync-metadata" },
      reviewedAt: REVIEWED_MENTO_LIVE_REDEMPTION_AT,
      outputAssetType: "stable-single",
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      docs: [
        sourceRef("Mento CDP docs", "https://docs.mento.org/mento-v3/dive-deeper/cdp", [
          "route",
          "capacity",
          "access",
          "settlement",
          "fees",
        ]),
        sourceRef("Mento CDP smart-contract docs", "https://docs.mento.org/mento-v3/build/smart-contracts/cdps", [
          "route",
          "capacity",
          "access",
          "settlement",
          "fees",
        ]),
        sourceRef("Mento V3 addresses", "https://docs.mento.org/mento-v3/build/deployments/addresses", [
          "route",
          "access",
        ]),
        sourceRef("Mento reserve dashboard", "https://reserve.mento.org/", ["capacity"]),
        MENTO_V3_DOC,
      ],
      notes: [
        "GBPm is a mento-protocol/bold (Liquity v2 fork) CDP branch collateralized by USDm.",
        "Live reserve sync now reads the branch's ActivePool debt against GBPm total supply each run, reporting the resulting ratio as direct redemption capacity, and CollateralRegistry.getRedemptionRateWithDecay() as the current redemption fee.",
      ],
    },
    "usdp-parallel": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT),
      outputAssetType: "mixed-collateral",
      outputAssets: [
        "asset:frxusd",
        "asset:sfrxusd",
        "asset:usde",
        "asset:susde",
        "asset:usds",
        "asset:susds",
        "asset:usdc",
        "asset:ygamiusdc",
      ],
      costModel: documentedVariableFee(
        "Parallelizer module: dynamic minting/burning fees adjust to correct peg deviations; depeg penalty applied proportionally",
      ),
      docs: [
        sourceRef(
          "Parallelizer Module",
          "https://docs.parallel.best/products/parallel-v3/how-it-works/parallelizer-module",
          ["route", "capacity", "fees"],
        ),
        sourceRef(
          "Parallelizer Module integration",
          "https://docs.parallel.best/developers-hub/parallel-v3/build-on-parallel/parallelizer-module-integration",
          ["route", "capacity"],
        ),
        sourceRef(
          "Parallel USDp implementation",
          "https://docs.parallel.best/products/parallel-v3/stablecoins-and-savings/usdp-and-susdp/implementation",
          ["route", "capacity"],
        ),
      ],
      notes: [
        "Output declared 2026-07-19: Parallel V3 docs state stablecoins can be burnt at oracle value for any asset in the backing (or redeemed pro-rata across it), and the implementation page lists the current per-chain backing set — frxUSD, sfrxUSD, USDe, sUSDe (Ethereum); USDS, sUSDS (Base); USDe, sUSDe (HyperEVM); USDC and the ygamiUSDC Silo Vault (Avalanche). The declared set is the full documented backing including the untracked ygamiUSDC vault token; the set is DAO-mutable.",
      ],
    },
    "hyusd-hylo": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
      routeStatus: "unknown",
      outputAssetType: "mixed-collateral",
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_AT,
      costModel: undisclosedReviewedFee(
        "Hylo V2 docs describe pool-specific dynamic redemption fees; the active production version and routable pool set could not be reconciled from public primary sources",
      ),
      docs: [
        sourceRef("Hylo multi-asset architecture", "https://docs.hylo.so/protocol-overview/multi-asset-architecture", [
          "route",
          "capacity",
        ]),
        sourceRef(
          "Hylo dynamic collateral routing",
          "https://docs.hylo.so/protocol-overview/dynamic-collateral-routing",
          ["route", "fees", "settlement"],
        ),
      ],
      notes: [
        "Hylo's current architecture page distinguishes V1's SOL-only LST pool from V2's independent SOL, BTC, and USDC collateral pools, and its routing page says redemptions select among pools using dynamic fees.",
        "No primary source reviewed identifies which architecture and complete pool/output set is active for the tracked hyUSD deployment. The route is therefore unknown and outputAssets is intentionally unset so neither the legacy SOL-only nor the V2 multi-asset claim can score.",
      ],
    },
    "fusd-freedom-dollar": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
      outputAssets: ["asset:zano"],
      executionModel: "rules-based-nav",
      outputAssetType: "bluechip-collateral",
      costModel: undisclosedReviewedFee(
        "Freedom Dollar materials describe protocol conversion between fUSD and ZANO at the target dollar value; public materials reviewed do not publish one fixed redemption fee",
      ),
      docs: [
        sourceRef("Freedom Dollar overview", "https://www.freedomdollar.com/en", ["route", "capacity", "access"]),
        sourceRef("Freedom Dollar mechanics", "https://www.freedomdollar.com/how-it-works", [
          "route",
          "capacity",
          "fees",
          "settlement",
        ]),
      ],
      notes: [
        "Freedom Dollar is modeled as decentralized protocol conversion into ZANO reserve value rather than issuer fiat redemption.",
      ],
    },
    "satusd-river": {
      ...collateralRedeemBase,
      ...reviewedDirectRedemptionSupplyFull,
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
      outputAssets: ["asset:btc", "asset:eth", "asset:bnb"],
      costModel: undisclosedReviewedFee(
        "Omni-CDP with $1-of-collateral redemption arbitrage; public fee schedule not disclosed",
      ),
      docs: [
        sourceRef("River satUSD redemption docs", "https://docs.river.inc/products/editor/redemption", [
          "route",
          "capacity",
          "fees",
        ]),
        sourceRef("River FAQ", "https://docs.river.inc/intro/faq", ["route", "capacity"]),
      ],
      notes: [
        "Output declared 2026-07-19: River docs state holders can exchange 1 satUSD for $1 worth of collateral from the least-collateralized positions, and the FAQ names the collateral classes as BTC, ETH, BNB, and other liquid staking tokens; the declared set covers the three named bluechip classes while individual LSTs (e.g. solvBTC, LBTC) are not exhaustively enumerated in public docs.",
      ],
    },
    "doc-money-on-chain": {
      ...collateralRedeemBase,
      outputAssets: ["asset:btc"],
      ...documentedBoundSupplyFull(REVIEWED_WRAPPER_WAVE_AT),
      costModel: undisclosedReviewedFee(
        "Money On Chain docs describe permissionless DOC redemption into RBTC, but the reviewed public materials do not publish a single fixed numeric redemption fee schedule",
      ),
      docs: [
        sourceRef("DOC overview", "https://moneyonchain.com/doc-stablecoin/", ["route"]),
        sourceRef(
          "Money On Chain main concepts",
          "https://docs.moneyonchain.com/main-rbtc-contract/money-on-chain-platform/main-concepts",
          ["route", "capacity"],
        ),
        sourceRef(
          "Redeeming DOCs",
          "https://docs.moneyonchain.com/main-rbtc-contract/integration-with-moc-platform/getting-docs/redeeming-docs",
          ["route", "fees"],
        ),
      ],
      notes: [
        "Money On Chain documents a permissionless DOC -> RBTC redemption path for the BTC-backed system, so Pharos models the direct collateral exit rather than relying only on secondary-market liquidity",
        "The current route remains documented-bound until a dedicated Rootstock reserve adapter exposes fresh current protocol capacity and fee telemetry",
      ],
    },
    "usbd-bima": {
      ...collateralRedeemBase,
      ...reviewedDirectRedemptionSupplyFull,
      outputAssets: ["asset:btc"],
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(
        "Redemption fee = coreRate + 75 bps; coreRate rises with redeemed supply and decays with a 24-hour half-life",
        "formula",
      ),
      docs: [
        sourceRef("BIMA redeeming USBD", "https://docs.bima.money/redeeming-usbd", ["route", "capacity", "fees"]),
        sourceRef("BIMA risk management + liquidations", "https://docs.bima.money/risk-management-+-liquidations", [
          "capacity",
        ]),
      ],
      notes: [
        "Docs also describe a PSM against USDC, USDP, and GUSD, but the primary modeled exit is direct redemption into BTC-derivative vault collateral",
      ],
    },
    "deuro-deuro": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull("2026-04-16"),
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(
        "dEURO allows burning tokens against collateralized positions below the position's redemption threshold; public docs reviewed describe a governance-managed fee schedule without a single fixed bps number",
      ),
      docs: [
        sourceRef("dEURO documentation", "https://docs.deuro.com/", ["route", "capacity"]),
        sourceRef("dEURO app", "https://app.deuro.com/", ["route"]),
      ],
      notes: [
        "Frankencoin-fork CDP: dEURO is minted against position-specific collateral and burned at par against positions below their redemption threshold, without an external stablecoin target rail",
      ],
    },
    "cjpy-yamato": {
      ...collateralRedeemBase,
      outputAssets: ["asset:eth"],
      ...documentedBoundSupplyFull("2026-04-16"),
      outputAssetType: "bluechip-collateral",
      costModel: documentedVariableFee(
        "Yamato docs describe on-chain CJPY-for-ETH redemption against the riskiest pledge; fee structure is set by protocol mechanics rather than a single fixed bps number",
      ),
      docs: [
        sourceRef("Yamato Protocol", "https://yamato.jp/", ["route"]),
        sourceRef("Yamato docs", "https://yamato-protocol.gitbook.io/docs/", ["route", "capacity", "fees"]),
      ],
      notes: [
        "On-chain redemption redeems 1 CJPY for 1 JPY worth of ETH from the riskiest pledge, providing a permissionless hard floor",
      ],
    },
    "uusd-youves": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
      outputAssets: ["asset:xtz", "asset:tzbtc", "asset:sirs", "asset:usdt"],
      settlementModel: "days",
      executionModel: "rules-based-nav",
      outputAssetType: "mixed-collateral",
      costModel: fixedFee(
        625,
        "Holder conversion price is 0.9375 of target value, implying a 6.25% haircut before collateral market-price conversion",
      ),
      docs: [
        sourceRef(
          "Youves holder conversion right",
          "https://docs.youves.com/syntheticAssets/stableTokens/incentiveFeatures/userConversionRights/Holder-Conversion-Right/",
          ["route", "capacity", "access", "settlement"],
        ),
        sourceRef(
          "Youves conversion terms",
          "https://docs.youves.com/syntheticAssets/stableTokens/incentiveFeatures/userConversionRights/User-Conversion-Terms/",
          ["route", "fees", "settlement"],
        ),
        sourceRef(
          "Youves collateral management",
          "https://docs.youves.com/syntheticAssets/stableTokens/collateralManagement/Collateral-Management-Details",
          ["capacity"],
        ),
      ],
      notes: [
        "Youves is modeled through the holder conversion right, not borrower repayment: uUSD holders can announce conversion and sell locked uUSD against eligible collateral after the 24-hour window unless a minter volunteers sooner",
        "Vaults above the holder conversion barrier cannot be selected, so the route is a documented stress-floor mechanism with execution constraints rather than an instant redeem-all buffer",
      ],
    },
    "fpi-frax": {
      ...collateralRedeemBase,
      ...reviewedDirectRedemptionSupplyFull,
      outputAssets: ["asset:frax"],
      capacityModel: { kind: "reserve-sync-metadata" },
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(
        "CPI-indexed redemption price grows on-chain per second at 12-month US CPI-U rate; 100% collateral ratio maintained via AMOs",
      ),
      docs: [
        sourceRef(
          "Frax Price Index overview",
          "https://docs.frax.finance/frax-price-index/overview-cpi-peg-and-mechanics",
          ["route", "capacity"],
        ),
        sourceRef("Frax website", "https://frax.com/", ["route"]),
      ],
      notes: [
        "Tracked metadata describes FPI as redeemable against a fully collateralized FRAX-backed system with the redemption price moving on-chain with CPI rather than staying fixed at $1",
        "Fresh FPI collateral telemetry uses the FRAX-denominated stable buckets of FPI's collateral as live proxy redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
      ],
    },
    "hbd-hive": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_HIVE_HBD_AT),
      outputAssets: ["asset:hive"],
      settlementModel: "days",
      executionModel: "rules-based-nav",
      outputAssetType: "mixed-collateral",
      costModel: undisclosedReviewedFee(
        "Hive conversions settle over the protocol conversion window and can be affected by HBD debt-ratio haircut mechanics; public docs reviewed do not publish a fixed redemption fee",
      ),
      notes: [
        "HBD is modeled as a protocol conversion route rather than a fiat issuer rail: holders can convert HBD through Hive mechanics, but the output and haircut behavior depend on protocol debt-ratio conditions",
      ],
      docs: [sourceRef("Hive HBD", "https://hive.io/hbd/", ["route", "capacity", "fees", "settlement"])],
    },
    "djed-coti": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
      outputAssets: ["asset:ada"],
      outputAssetType: "mixed-collateral",
      executionModel: "rules-based-nav",
      costModel: undisclosedReviewedFee(
        "Djed app/docs describe burning DJED against ADA reserves subject to reserve-ratio rules; public materials reviewed do not publish one global fixed redemption fee",
      ),
      docs: [
        sourceRef("Djed app", "https://app.djed.xyz/", ["route", "capacity", "fees", "access", "settlement"]),
        sourceRef(
          "Djed mainnet announcement",
          "https://cotinetwork.medium.com/djed-is-now-available-on-mainnet-9a2ac66daea4",
          ["route", "capacity", "fees", "access", "settlement"],
        ),
      ],
      notes: [
        "Modeled as Cardano protocol collateral redemption into ADA reserves, with SHEN reserve-ratio constraints rather than issuer fiat redemption.",
      ],
    },
    "zsd-zephyr-protocol": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
      outputAssets: ["asset:zeph"],
      executionModel: "rules-based-nav",
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(
        "Zephyr conversion fees are absorbed by reserves and depend on protocol conversion-rate mechanics rather than a single published fixed bps fee",
      ),
      docs: [
        sourceRef("Zephyr repository overview", "https://github.com/ZephyrProtocol/zephyr", [
          "route",
          "capacity",
          "fees",
        ]),
        sourceRef("Zephyr conversions dashboard", "https://zephyrprotocol.com/network/conversions", ["route", "fees"]),
        sourceRef("Zephyr integration documentation", "https://zephyrprotocol.com/documentation", [
          "route",
          "access",
          "settlement",
        ]),
      ],
      notes: [
        "Zephyr implements a Djed-inspired native reserve where users can mint or redeem ZSD against ZEPH base-coin collateral, with oracle and reserve-ratio rules governing execution",
        "Modeled as protocol collateral redemption into ZEPH rather than issuer fiat redemption; Pharos does not currently have native Zephyr-chain reserve telemetry, so capacity remains source-reviewed documented-bound",
      ],
    },
    "usdn-smardex": {
      ...collateralRedeemBase,
      ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
      outputAssets: ["asset:wsteth"],
      settlementModel: "days",
      executionModel: "rules-based-nav",
      outputAssetType: "bluechip-collateral",
      costModel: documentedVariableFee(
        "SMARDEX docs describe USDN burn/redemption for underlying vault value, with oracle validation and imbalance restrictions rather than one fixed redemption fee",
      ),
      docs: [
        sourceRef(
          "SMARDEX USDN protocol",
          "https://docs.smardex.io/ultimate-synthetic-delta-neutral/the-usdn-protocol",
          ["route", "capacity", "fees", "access", "settlement"],
        ),
      ],
      notes: [
        "Modeled as a collateral redemption route into wstETH-backed vault value; protocol imbalance and validation windows can delay or restrict execution.",
      ],
    },
  }),
];

export const COLLATERAL_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> =
  defineBackstopRegistry(COLLATERAL_REDEEM_REGISTRY_ENTRIES);

applyTrackedReviewedDocs(COLLATERAL_REDEEM_BACKSTOP_CONFIGS, [
  "feusd-felix",
  "meusd-mezo",
  "nect-beraborrow",
  "usdq-quill",
  "usdaf-asymmetry",
  "ebusd-ebisu",
  "reusd-resupply",
  "satusd-river",
]);

applyTrackedReviewedDocs(
  COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
  ["ussd-sonic-labs", "usdp-parallel"],
  REVIEWED_REMEDIATION_AT,
);

applyTrackedReviewedDocs(COLLATERAL_REDEEM_BACKSTOP_CONFIGS, ["hbd-hive"], REVIEWED_HIVE_HBD_AT);

/** Declared after the doc backfills above so the entries carry the finished configs. */
export const COLLATERAL_REDEEM_BACKSTOP_ENTRIES = rebindEntriesToRegistry(
  COLLATERAL_REDEEM_REGISTRY_ENTRIES,
  COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
);
