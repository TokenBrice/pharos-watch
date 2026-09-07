import type { RedemptionBackstopConfig } from "./shared";
import { defineBatch, defineConfigFamily, defineRecordEntries, finalizeBackstopRegistry } from "./factory";
import {
  collateralRedeemBase,
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  fixedFee,
  LIQUITY_STYLE_REDEMPTION_FEE,
  sourceRef,
  sourceRefFull,
  sourceRefRouteCapacity,
  sourceRefRouteCapacityAccess,
  sourceRefRouteCapacityFees,
} from "./shared";
import {
  REVIEWED_DIRECT_REDEMPTION_AT,
  REVIEWED_EXIT_CREDIT_WAVE3_AT,
  REVIEWED_FOLLOWUP_REMEDIATION_AT,
  REVIEWED_MAY_BATCH_AT,
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
} from "./review-dates";
const REVIEWED_HIVE_HBD_AT = REVIEWED_MAY_BATCH_AT;
// Mento redemption batch: 13 coins' live reserve sync now reads direct
// on-chain redemption telemetry (Broker/BiPoolManager pools, the GBPm
// Liquity-v2-fork CDP, or the JPYm/CHFm FPMM pools), so their capacity model
// moves from documented-bound to reserve-sync-metadata.
const REVIEWED_MENTO_LIVE_REDEMPTION_AT = "2026-07-09";
const REVIEWED_REDEMPTION_OUTPUTS_AT = "2026-07-15";
const REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT = "2026-07-19";
const MENTO_BIPOOLMANAGER_DOC = sourceRefRouteCapacityFees(
  "Mento BiPoolManager smart-contract docs",
  "https://docs.mento.org/mento/build-on-mento/smart-contracts/bipoolmanager",
);
const MENTO_V3_DOC = sourceRef("Mento V3 docs", "https://docs.mento.org/mento-v3", ["route"]);
const MENTO_V3_FPMM_DOC = sourceRef("Mento V3 FPMM mechanics", "https://docs.mento.org/mento-v3/dive-deeper/fpmm", [
  "route",
  "capacity",
  "fees",
  "settlement",
]);
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

function defineLiveCollateralConfig(overrides: Partial<RedemptionBackstopConfig>): RedemptionBackstopConfig {
  return { ...collateralRedeemBase, capacityModel: { kind: "reserve-sync-metadata" }, ...overrides };
}

function defineCollateralConfig(overrides: Partial<RedemptionBackstopConfig>): RedemptionBackstopConfig { return { ...collateralRedeemBase, ...overrides }; }

function defineReviewedCollateralConfig(reviewedAt: string, overrides: Partial<RedemptionBackstopConfig>): RedemptionBackstopConfig {
  return { ...collateralRedeemBase, ...documentedBoundSupplyFull(reviewedAt), ...overrides };
}

// JPYm/CHFm: live telemetry now reads the coin's Mento V3 FPMM pool USDm
// balance as direct redemption capacity; the underlying CDP fee mechanics
// (and its costModel) are unchanged, per reviewed docs.
const mentoFpmmPoolRedeemConfig: RedemptionBackstopConfig = defineLiveCollateralConfig({
  reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
  outputAssetType: "stable-single",
  outputAssets: ["cusd-celo"],
  costModel: documentedVariableFee(
    "Mento V3 FPMM swap fee, set on-chain per pool as lpFee + protocolFee in basis points (currently 20 + 10 = 30 bps on both the JPYm and CHFm pools, contract-capped at 200 bps combined); live telemetry supplies the current bps",
    "formula",
  ),
  docs: [
    sourceRefRouteCapacityAccess("Mento V3 reserve docs", "https://docs.mento.org/mento-v3/dive-deeper/the-reserve"),
    sourceRef("Getting Mento stables on Celo", "https://docs.mento.org/mento-v3/other/getting-mento-stables/on-celo", [
      "route",
      "fees",
      "settlement",
      "access",
    ]),
    sourceRef("Mento reserve dashboard", "https://reserve.mento.org/", ["capacity", "fees", "settlement"]),
    sourceRef(
      "Mento V3 FPMM verified implementation",
      "https://celo.blockscout.com/address/0x8cB0518a0510Ab62450F79f3cD9EE0cbdDB77F30?tab=contract",
      ["fees"],
    ),
    MENTO_V3_FPMM_DOC,
    MENTO_V3_DOC,
  ],
  notes: [
    "Mento CDP-backed FX stables are modeled as on-chain collateral redemptions into USDm collateral rather than issuer fiat redemption.",
    "Live reserve sync now reads the coin's Mento V3 FPMM pool USDm balance each run and reports it as direct redemption capacity, replacing the prior documented-bound/eventual-only model.",
    "The pool's swap fee is also read live: the verified FPMM implementation behind both pool proxies stores lpFee() and protocolFee() in basis points on a 10,000 denominator and charges their sum symmetrically in getAmountOut(), with setLPFee/setProtocolFee reverting FeeTooHigh above 200 bps combined. Both pools read 20 + 10 = 30 bps on 2026-08-12.",
    "Output declared 2026-07-19: Mento V3 CDP docs name USDm as the collateral asset of the FX-stable CDP/FPMM path, so the redemption pays USDm (tracked cusd-celo), mirroring the jpym-mento precedent; declaration was previously blocked on cusd-celo being untracked.",
  ],
});

// cUSD (USDm), cEUR (EURm), and the 8 local-FX stables all redeem through a
// Mento Broker/BiPoolManager pool against a stable or USDm counter asset.
const mentoBrokerPoolRedeemConfig: RedemptionBackstopConfig = defineLiveCollateralConfig({
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
});

const MENTO_ROUTE_CONFIGS = defineConfigFamily(
  [
    {
      id: "cusd-celo",
      outputAssets: ["usdc-circle", "usdt-tether"],
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_AT,
      outputAssetType: "stable-basket" as const,
      costModel: documentedVariableFee(
        "Mento broker pool spread, set on-chain per pool (PoolConfig.spread, currently 5 bps on USDm stable pools per MGP-13); live telemetry supplies the current bps",
        "formula",
      ),
      docs: [
        sourceRefRouteCapacity("Mento V3 reserve docs", "https://docs.mento.org/mento-v3/dive-deeper/the-reserve"),
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
    {
      id: "ceur-celo",
      outputAssets: ["cusd-celo"],
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_AT,
      outputAssetType: "stable-single" as const,
      costModel: documentedVariableFee(
        "Mento broker pool spread, set on-chain per pool (PoolConfig.spread, currently 5 bps on USDm stable pools per MGP-13); live telemetry supplies the current bps",
        "formula",
      ),
      docs: [
        sourceRefRouteCapacity("Mento V3 reserve docs", "https://docs.mento.org/mento-v3/dive-deeper/the-reserve"),
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
    {
      id: "gbpm-mento",
      outputAssets: ["cusd-celo"],
      reviewedAt: REVIEWED_MENTO_LIVE_REDEMPTION_AT,
      outputAssetType: "stable-single" as const,
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
  ],
  ({ id: _id, ...row }) => defineLiveCollateralConfig(row),
);

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
    "bold-liquity": defineLiveCollateralConfig({
      outputAssets: ["asset:weth", "asset:wsteth", "asset:reth"],
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      reviewedAt: "2026-03-22",
      docs: [
        sourceRefRouteCapacityFees("Liquity V2 redemption docs", "https://docs.liquity.org/v2-faq/redemptions-and-delegation"),
        sourceRefRouteCapacityFees("Liquity v2 repository", "https://github.com/liquity/bold"),
      ],
      notes: [
        "Fresh live reserve metadata reads Liquity v2 ActivePool branch debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
      ],
    }),
    "bd-basedollar": defineLiveCollateralConfig({
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:weth", "asset:wsteth", "asset:reth", "asset:cbbtc", "asset:cbeth"],
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      reviewedAt: "2026-08-21",
      docs: [
        sourceRefFull(
          "Base Dollar redemption mechanics",
          "https://github.com/basedollar/basedollar/blob/fd325e5aeafa2e4881a4a2d32451dfc9dfa0d941/README.md#bold-redemptions",
        ),
        sourceRefRouteCapacity(
          "Base Dollar production deployment",
          "https://github.com/basedollar/basedollar/blob/fd325e5aeafa2e4881a4a2d32451dfc9dfa0d941/contracts/broadcast/DeployLiquity2.s.sol/8453/run-latest.json",
        ),
        sourceRef(
          "Base Dollar CollateralRegistry",
          "https://basescan.org/address/0x7551ebfc8340b7f91874942be9c653733d4fb04f#code",
          ["route", "fees", "access", "settlement"],
        ),
      ],
      notes: [
        "Fresh live reserve metadata reads all five Base Dollar ActivePool branch debts as the current direct redemption-capacity bound; an unavailable or degraded on-chain snapshot leaves the route unrated instead of falling back to full supply.",
        "Base Dollar's launch branches settle redemptions in WETH, wstETH, rETH, wrapped cbBTC, and cbETH; the wrapped cbBTC branch is normalized to the underlying cbBTC price while preserving the branch's 18-decimal accounting token.",
      ],
    }),
    "lusd-liquity": defineLiveCollateralConfig({
      outputAssets: ["asset:eth"],
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      reviewedAt: "2026-03-22",
      docs: [
        sourceRefRouteCapacityFees("Liquity redemption docs", "https://docs.liquity.org/liquity-v1/faq/lusd-redemptions"),
        sourceRef("Liquity v1 contract addresses", "https://docs.liquity.org/liquity-v1/documentation/resources", [
          "capacity",
        ]),
      ],
      notes: [
        "Fresh live reserve metadata reads Liquity v1 TroveManager system debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
      ],
    }),
    "feusd-felix": defineLiveCollateralConfig({
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:whype", "asset:feubtc", "asset:khype", "asset:wsthype"],
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      costModel: fixedFee(0, "Felix docs describe redemption as fee-free"),
    }),
    "meusd-mezo": defineLiveCollateralConfig({
      outputAssets: ["asset:btc"],
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      costModel: fixedFee(75, "75 bps standard; 0 bps when redeeming against your own debt"),
      docs: [
        sourceRefRouteCapacityFees("Mezo MUSD overview", "https://mezo.org/docs/users/musd/"),
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
    }),
    "nect-beraborrow": defineLiveCollateralConfig({
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      docs: [
        sourceRefRouteCapacityFees(
          "Beraborrow NECT peg docs",
          "https://beraborrow.gitbook.io/docs/nect-stablecoin/redemptions/usdnect-peg",
        ),
      ],
      notes: [
        "Fresh live reserve metadata reads Beraborrow's Liquity v2-style ActivePool branch debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
      ],
    }),
    "fxusd-f-x-protocol": defineLiveCollateralConfig({
      outputAssets: ["asset:wsteth", "asset:wbtc"],
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      costModel: fixedFee(50, "Protocol docs list a 50 bps redemption fee"),
      docs: [
        sourceRefRouteCapacityFees("f(x) docs", "https://fxprotocol.gitbook.io/fx-docs"),
        sourceRef("f(x) app", "https://fx.aladdin.club", ["capacity"]),
      ],
      notes: [
        "Tracked metadata describes direct oracle-priced collateral redemption when fxUSD trades below peg; current model scores that primary onchain redemption rail rather than Curve secondary liquidity",
      ],
    }),
    "usdaf-asymmetry": defineLiveCollateralConfig({
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      outputAssets: ["asset:wbtc", "asset:tbtc", "asset:susds", "asset:sfrxusd", "asset:scrvusd", "asset:ysybold"],
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
    }),
    "usdq-quill": defineLiveCollateralConfig({
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      outputAssets: ["asset:weth", "asset:wsteth", "asset:weeth", "asset:scr"],
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
    }),
    "cdp-enosys": defineLiveCollateralConfig({
      outputAssets: ["asset:fxrp", "asset:wflr"],
      reviewedAt: REVIEWED_FOLLOWUP_REMEDIATION_AT,
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
      docs: [
        sourceRefFull(
          "Flare Enosys Loans launch update",
          "https://flare.network/news/enosys-loans-xrp-backed-stablecoin-flare",
        ),
      ],
      notes: [
        "Modeled as a Liquity V2-style collateral redemption route on Flare; lowest-rate troves are redeemed first when CDP trades below peg.",
        "Fresh live reserve metadata reads Enosys ActivePool branch debt and collateral balances on Flare as the current direct redemption-capacity bound.",
      ],
    }),
    "ausdt-tether-alloy": defineReviewedCollateralConfig("2026-04-20", {
      accessModel: "whitelisted-onchain",
      outputAssetType: "bluechip-collateral",
      costModel: fixedFee(
        25,
        "Alloy CMPVault MINT_OPENING_RETURN_FEE() returns 0xfa, which is 25 bps on the contract's 1e5 fee scale; docs identify this parameter as the return fee",
      ),
      docs: [
        sourceRefRouteCapacity("Alloy vault docs", "https://docs.alloy.tether.to/alloy-by-tether/alloy-by-tether-vaults"),
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
    }),
    "ussd-sonic-labs": defineLiveCollateralConfig({
      outputAssetType: "stable-single",
      outputAssets: ["frxusd-frax"],
      reviewedAt: REVIEWED_EXIT_CREDIT_WAVE3_AT,
      costModel: fixedFee(0, "The verified Sonic BrandedCustodian returned redeemFee() = 0 at Sonic block 77432523."),
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
        "Sonic's public page describes a broader upstream supported-USD-asset set, but the deployed direct holder route is the USSD BrandedCustodian. At Sonic block 77432523 its custodianTkn() returned Sonic frxUSD (0x80Eede496655FB9047dd39d9f418d5483ED600df).",
        "Fresh reserve telemetry reads the BrandedCustodian's totalAssets() (its frxUSD balance) as the live executable exit bound; when the read is unavailable the route is left unrated instead of assuming full-supply immediacy.",
        "Re-read 2026-08-12 at Sonic block 77432523: totalAssets() and frxUSD.balanceOf(custodian) both returned 2,081,316.47, confirming the escrow read measures the asset the redemption pays out; redeemFee() was still 0 and paused() reverts, so the verified source exposes no pause surface.",
      ],
    }),
    "reusd-resupply": defineLiveCollateralConfig({
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_WAVE2_AT,
      outputAssetType: "mixed-collateral",
      outputAssets: ["asset:crvusd", "asset:frxusd"],
      costModel: fixedFee(100, "Communal redemption model with 1% fee establishing a price floor"),
      docs: [
        sourceRefRouteCapacityFees("Resupply stability mechanics", "https://docs.resupply.fi/resupply-protocol/stability-mechanics"),
        sourceRefRouteCapacity(
          "Resupply collateralized debt positions",
          "https://docs.resupply.finance/resupply-protocol/collateralized-debt-positions",
        ),
        sourceRef("Resupply app", "https://resupply.fi/redeem", ["route", "capacity", "settlement"]),
      ],
      notes: [
        "Fresh Resupply pair telemetry reads RedemptionHandler.getMaxRedeemableDebt() and the permissionless guard state as the current executable capacity bound; when the guard is closed, the route stays visible but does not enter or uplift V9 Exit",
        "Output declared 2026-07-19: Resupply docs state all reUSD collateral backing consists of crvUSD supplied to Curve Lend or frxUSD supplied to Frax Lend, and the redeemer chooses which pools to redeem against, so the payout is the chosen pools' crvUSD/frxUSD-denominated lending collateral.",
      ],
    }),
    ...MENTO_ROUTE_CONFIGS,
    "usdp-parallel": defineLiveCollateralConfig({
      // Live-only since v4.35: the escrow-balance adapter sums the
      // Parallelizer's per-collateral getIssuedByCollateral reads (verified
      // proportional basket redemption, so the sum is the honest bound); when
      // the read is unavailable the route is left unrated instead of assuming
      // full-supply immediacy.
      capacityModel: { kind: "reserve-sync-metadata", basis: "live-direct-telemetry" },
      reviewedAt: "2026-08-12",
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
        sourceRefRouteCapacityFees(
          "Parallelizer Module",
          "https://docs.parallel.best/products/parallel-v3/how-it-works/parallelizer-module",
        ),
        sourceRefRouteCapacity(
          "Parallelizer Module integration",
          "https://docs.parallel.best/developers-hub/parallel-v3/build-on-parallel/parallelizer-module-integration",
        ),
        sourceRefRouteCapacity(
          "Parallel USDp implementation",
          "https://docs.parallel.best/products/parallel-v3/stablecoins-and-savings/usdp-and-susdp/implementation",
        ),
      ],
      notes: [
        "Output declared 2026-07-19: Parallel V3 docs state stablecoins can be burnt at oracle value for any asset in the backing (or redeemed pro-rata across it), and the implementation page lists the current per-chain backing set — frxUSD, sfrxUSD, USDe, sUSDe (Ethereum); USDS, sUSDS (Base); USDe, sUSDe (HyperEVM); USDC and the ygamiUSDC Silo Vault (Avalanche). The declared set is the full documented backing including the untracked ygamiUSDC vault token; the set is DAO-mutable.",
      ],
    }),
    "hyusd-hylo": defineReviewedCollateralConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
      routeStatus: "unknown",
      outputAssetType: "mixed-collateral",
      reviewedAt: REVIEWED_REDEMPTION_OUTPUTS_AT,
      costModel: undisclosedReviewedFee(
        "Hylo V2 docs describe pool-specific dynamic redemption fees; the active production version and routable pool set could not be reconciled from public primary sources",
      ),
      docs: [
        sourceRefRouteCapacity("Hylo multi-asset architecture", "https://docs.hylo.so/protocol-overview/multi-asset-architecture"),
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
    }),
    "fusd-freedom-dollar": defineReviewedCollateralConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
      outputAssets: ["asset:zano"],
      executionModel: "rules-based-nav",
      outputAssetType: "bluechip-collateral",
      costModel: undisclosedReviewedFee(
        "Freedom Dollar materials describe protocol conversion between fUSD and ZANO at the target dollar value; public materials reviewed do not publish one fixed redemption fee",
      ),
      docs: [
        sourceRefRouteCapacityAccess("Freedom Dollar overview", "https://www.freedomdollar.com/en"),
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
    }),
    "satusd-river": defineLiveCollateralConfig({
      reviewedAt: "2026-08-27",
      unresolvedOutputDisposition: "issuer-undisclosed",
      costModel: documentedVariableFee(
        "Redemption fee = redemptionFeeFloor (50 bps) + baseRate, where baseRate rises with redeemed supply and decays over time",
        "formula",
      ),
      docs: [
        sourceRefRouteCapacityFees("River satUSD redemption docs", "https://docs.river.inc/products/editor/redemption"),
        sourceRefRouteCapacity("River FAQ", "https://docs.river.inc/intro/faq"),
        sourceRef(
          "Satoshi Protocol TroveManager source (pinned)",
          "https://github.com/Satoshi-Protocol/satoshi-core/blob/7f5eddaed965904fde10ea1d40c4c4b3ea118ada/src/core/TroveManager.sol",
          ["fees"],
        ),
      ],
      notes: [
        "Output re-reviewed 2026-08-27: River docs state holders can exchange 1 satUSD for $1 worth of collateral from the least-collateralized positions, and the FAQ names BTC, ETH, BNB, and other liquid staking tokens as redemption collateral. The public materials do not enumerate the complete eligible LST inventory, so outputAssets is intentionally unset rather than publishing the three named assets as a complete payout composition.",
        "Fee model corrected 2026-08-12: the schedule is disclosed, not undisclosed. River documents the fee as `baseRate + 0.5%`, and the deployed TroveManager exposes it through `getRedemptionRate()`/`getRedemptionRateWithDecay()` as `min(redemptionFeeFloor + baseRate, maxRedemptionFee)`.",
        "No static fee bound is declared: `maxRedemptionFee` is a per-branch governance parameter constrained only by `maxRedemptionFee <= DECIMAL_PRECISION` (100%), so the documented ceiling is two orders of magnitude above the 200 bps admissible bound. The live adapter instead reads each branch's `getRedemptionRateWithDecay()` in the same run, so the current cost comes from telemetry rather than from a reviewed ceiling.",
        "Fresh reserve telemetry reads per-chain trove debt through the Satoshi app's `getGlobalSystemBalances()` as the executable exit bound, after checking that `debtToken()` still round-trips to this coin's own satUSD deployment and that the global TCR clears each branch MCR. The prior documented-bound full-supply model is dropped with no fallback: satUSD is largely bridged or Smart-Vault-minted rather than trove-backed, so total supply never described what the redemption engine could honor, and an unavailable read now leaves the route unrated instead of restoring that figure.",
      ],
    }),
    "doc-money-on-chain": defineCollateralConfig({
      outputAssets: ["asset:btc"],
      capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.95, confidence: "documented-bound" },
      reviewedAt: REVIEWED_EXIT_CREDIT_WAVE3_AT,
      costModel: undisclosedReviewedFee(
        "Money On Chain docs describe permissionless DOC redemption into RBTC, but the reviewed public materials do not publish a single fixed numeric redemption fee schedule",
      ),
      docs: [
        sourceRef("DOC overview", "https://moneyonchain.com/doc-stablecoin/", ["route"]),
        sourceRefRouteCapacity(
          "Money On Chain main concepts",
          "https://docs.moneyonchain.com/main-rbtc-contract/money-on-chain-platform/main-concepts",
        ),
        sourceRef(
          "Redeeming DOCs",
          "https://docs.moneyonchain.com/main-rbtc-contract/integration-with-moc-platform/getting-docs/redeeming-docs",
          ["route", "fees"],
        ),
      ],
      notes: [
        "Money On Chain documents a permissionless DOC -> RBTC redemption path for the BTC-backed system, so Pharos models the direct collateral exit rather than relying only on secondary-market liquidity",
        "Fresh reserve telemetry reads MoCState.freeDoc() — the DOC amount currently redeemable through redeemFreeDoc — identity-bound to the tracked DOC token through the MoC connector; the 95% documented ratio applies only when the live read is unavailable.",
        "Verified 2026-08-12: MoCState 0xb9C42EFc8ec54490a37cA91c423F7285Fa01e257 returned freeDoc() = 2,874,833.75, its connector() and the connector's docToken() resolved to the tracked Rootstock DOC deployment, and the probe's pause target read false. The documented fallback stays because DOC is also deployed on Arbitrum and Ethereum while only the Rootstock-local balance is redeemable, and Rootstock exposes a single public RPC.",
      ],
    }),
    "usbd-bima": defineReviewedCollateralConfig(REVIEWED_DIRECT_REDEMPTION_AT, {
      outputAssets: ["asset:btc"],
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(
        "Redemption fee = coreRate + 75 bps; coreRate rises with redeemed supply and decays with a 24-hour half-life",
        "formula",
      ),
      docs: [
        sourceRefRouteCapacityFees("BIMA redeeming USBD", "https://docs.bima.money/redeeming-usbd"),
        sourceRef("BIMA risk management + liquidations", "https://docs.bima.money/risk-management-+-liquidations", [
          "capacity",
        ]),
      ],
      notes: [
        "Docs also describe a PSM against USDC, USDP, and GUSD, but the primary modeled exit is direct redemption into BTC-derivative vault collateral",
      ],
    }),
    "deuro-deuro": defineLiveCollateralConfig({
      reviewedAt: "2026-08-12",
      outputAssetType: "stable-basket",
      unresolvedOutputAssetKeys: [
        "asset:eurt",
        "eurs-stasis",
        "asset:veur",
        "eurc-circle",
        "eurr-stablr",
        "europ-schuman",
        "euri-banking-circle",
        "asset:eure-legacy-ethereum",
        "asset:eura",
      ],
      unresolvedOutputDisposition: "reviewed-external",
      costModel: fixedFee(
        0,
        "Verified StablecoinBridge source burns dEURO and transfers the decimal-converted underlying amount 1:1 with no fee deduction",
      ),
      docs: [
        sourceRefRouteCapacityAccess("dEURO contract registry", "https://docs.deuro.com/smart-contracts"),
        sourceRef("dEURO stablecoin bridges", "https://docs.deuro.com/swap", [
          "route",
          "capacity",
          "fees",
          "settlement",
        ]),
        sourceRefFull(
          "dEURO StablecoinBridge source",
          "https://github.com/d-EURO/smartContracts/blob/develop/contracts/StablecoinBridge.sol",
        ),
        sourceRef(
          "Verified EURC StablecoinBridge deployment",
          "https://eth.blockscout.com/address/0xB4fF7412f08C22d7381885e8BdA9EE9825092fd1?tab=contract",
          ["route", "capacity", "fees", "settlement"],
        ),
      ],
      notes: [
        "The modeled holder exit is the permissionless StablecoinBridge burn rail, not position collateral: each bridge burns dEURO and atomically transfers its configured Euro stablecoin after decimal conversion.",
        "Live reserve sync identity-gates all nine registry bridges against their exact underlying token, underlying decimals, the tracked dEURO contract, and dEURO isMinter(bridge), then sums idle underlying inventory. Any failed read or identity mismatch withholds the entire redemption telemetry block; there is no supply-ratio or fixed-USD fallback.",
        "Verified at Ethereum block 25737329: EURT 0; EURS 0.51; VEUR 0; EURC 456,236.347273; EURR 0; EUROP 0; EURI 0.121078948117731513; EURE 56.444074572681000575; EURA 0.013878229134009314. All eur() and dEURO() identities, token decimals, and isMinter checks passed; total idle inventory was 456,293.436304749932741402 EUR.",
        "Capacity is stored in USD as required by reserve-sync metadata. The adapter derives EUR/USD from the same dEURO price payload as price.usd / price.eur, avoiding a false 1 EUR = 1 USD assumption; the live review reference was 1.150811321981997 USD/EUR ($525,107.65 capacity).",
        "The basket remains unresolved under the July 2026 completeness rule. EURS, EURC, EURR, EUROP, and EURI map to exact tracked deployments; EURT, VEUR, EURA, and the legacy Ethereum EURE token at 0x3231...273f do not, so publishing only the five tracked members would falsely resolve the nine-member route.",
        "Blockscout verified six bridge deployments as StablecoinBridge with the fee-free burn path; Sourcify exact runtime/creation matches verified the three deployments absent from Blockscout source (EURR, EUROP, EURA).",
      ],
    }),
    "cjpy-yamato": defineLiveCollateralConfig({
      outputAssets: ["asset:eth"],
      reviewedAt: "2026-08-12",
      // Live-only since v4.34: the Yamato adapter reads the priority
      // registry's redeemable cap each run (converted JPY -> ETH -> USD
      // through the protocol oracle and the shared ETH/USD reference); when
      // the read is unavailable the route is left unrated instead of
      // assuming full-supply immediacy.
      outputAssetType: "bluechip-collateral",
      costModel: documentedVariableFee(
        "Yamato docs describe on-chain CJPY-for-ETH redemption against the riskiest pledge; fee structure is set by protocol mechanics rather than a single fixed bps number",
      ),
      docs: [
        sourceRef("Yamato Protocol", "https://yamato.jp/", ["route"]),
        sourceRefRouteCapacityFees("Yamato docs", "https://yamato-protocol.gitbook.io/docs/"),
      ],
      notes: [
        "On-chain redemption redeems 1 CJPY for 1 JPY worth of ETH from the riskiest pledge, providing a permissionless hard floor",
      ],
    }),
    "uusd-youves": defineReviewedCollateralConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
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
    }),
    "fpi-frax": defineLiveCollateralConfig({
      outputAssets: ["asset:frax"],
      reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
      outputAssetType: "mixed-collateral",
      costModel: documentedVariableFee(
        "CPI-indexed redemption price grows on-chain per second at 12-month US CPI-U rate; 100% collateral ratio maintained via AMOs",
      ),
      docs: [
        sourceRefRouteCapacity(
          "Frax Price Index overview",
          "https://docs.frax.finance/frax-price-index/overview-cpi-peg-and-mechanics",
        ),
        sourceRef("Frax website", "https://frax.com/", ["route"]),
      ],
      notes: [
        "Tracked metadata describes FPI as redeemable against a fully collateralized FRAX-backed system with the redemption price moving on-chain with CPI rather than staying fixed at $1",
        "Fresh FPI collateral telemetry uses the FRAX-denominated stable buckets of FPI's collateral as live proxy redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
      ],
    }),
    "hbd-hive": defineReviewedCollateralConfig(REVIEWED_HIVE_HBD_AT, {
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
    }),
    "djed-coti": defineReviewedCollateralConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
      outputAssets: ["asset:ada"],
      outputAssetType: "mixed-collateral",
      executionModel: "rules-based-nav",
      costModel: undisclosedReviewedFee(
        "Djed app/docs describe burning DJED against ADA reserves subject to reserve-ratio rules; public materials reviewed do not publish one global fixed redemption fee",
      ),
      docs: [
        sourceRefFull("Djed app", "https://app.djed.xyz/"),
        sourceRefFull(
          "Djed mainnet announcement",
          "https://cotinetwork.medium.com/djed-is-now-available-on-mainnet-9a2ac66daea4",
        ),
      ],
      notes: [
        "Modeled as Cardano protocol collateral redemption into ADA reserves, with SHEN reserve-ratio constraints rather than issuer fiat redemption.",
      ],
    }),
    "zsd-zephyr-protocol": defineReviewedCollateralConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
      outputAssets: ["asset:zeph"],
      executionModel: "rules-based-nav",
      outputAssetType: "mixed-collateral",
      reviewedAt: REVIEWED_EXIT_CREDIT_WAVE3_AT,
      costModel: fixedFee(
        10,
        "Zephyr's consensus RingCT verification deducts a fixed 0.1% conversion fee from the ZSD/ZEPH exchange rate on every REDEEM_STABLE conversion",
      ),
      docs: [
        sourceRefRouteCapacityFees("Zephyr repository overview", "https://github.com/ZephyrProtocol/zephyr"),
        sourceRef(
          "Zephyr RingCT conversion-fee source (pinned)",
          "https://github.com/ZephyrProtocol/zephyr/blob/67c5f53b878fef41fb5e74c4382d5b7a2f37fd8a/src/ringct/rctSigs.cpp",
          ["fees"],
        ),
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
        "Fee bound declared 2026-08-12: the pinned source computes `conversion_fee = exchange_128 / 1000` in the REDEEM_STABLE branch, a fixed 10 bps deduction enforced by consensus rather than a governance-settable parameter. The branch is gated on `hf_version >= HF_VERSION_V5` (5) and Zephyr mainnet has run hard fork 11 since block 536000 (June 2025), so 10 bps is the fee in force today; the pre-HF5 200 bps path is unreachable. This mirrors the ZYS bound shipped in v4.33 from the same consensus source.",
        "The fee bound is separate from the reserve-ratio haircut: below full collateralization the protocol keeps redemption enabled but pays out at reserve divided by circulating ZSD, which the capacity model rather than the cost model represents.",
      ],
    }),
    "usdn-smardex": defineReviewedCollateralConfig(REVIEWED_STABLECOIN_AUDIT_AT, {
      outputAssets: ["asset:wsteth"],
      settlementModel: "days",
      executionModel: "rules-based-nav",
      outputAssetType: "bluechip-collateral",
      costModel: documentedVariableFee(
        "SMARDEX docs describe USDN burn/redemption for underlying vault value, with oracle validation and imbalance restrictions rather than one fixed redemption fee",
      ),
      docs: [
        sourceRefFull(
          "SMARDEX USDN protocol",
          "https://docs.smardex.io/ultimate-synthetic-delta-neutral/the-usdn-protocol",
        ),
      ],
      notes: [
        "Modeled as a collateral redemption route into wstETH-backed vault value; protocol imbalance and validation windows can delay or restrict execution.",
      ],
    }),
    "hchf-hedera-swiss-franc": defineReviewedCollateralConfig("2026-08-13", {
      outputAssets: ["asset:hbar"],
      costModel: documentedVariableFee(
        "HLiquity documents a dynamic redemption fee based on the amount redeemed relative to total HCHF supply; the fee is paid in HBAR",
        "formula",
      ),
      routeStatus: "open",
      docs: [
        sourceRef("HLiquity overview", "https://docs.hliquity.org/overview/overview", ["route", "access"]),
        sourceRefFull(
          "HLiquity redemptions and HCHF price stability",
          "https://docs.hliquity.org/deep-dive/redemptions-and-hchf-price-stability",
        ),
        sourceRef("HLiquity borrowing", "https://docs.hliquity.org/deep-dive/borrowing", ["capacity", "route"]),
        sourceRef("HLiquity Stability Pool and liquidations", "https://docs.hliquity.org/deep-dive/stability-pool-and-liquidations", [
          "capacity",
        ]),
        sourceRef("HLiquity contract registry", "https://docs.hliquity.org/fundamentals/token-ids-pools-contracts", [
          "route",
          "access",
        ]),
        sourceRef("HLiquity verified source repository", "https://github.com/SwisscoastAG/HLiquity", [
          "route",
          "access",
          "settlement",
        ]),
        sourceRef("Hedera mainnet mirror-node API", "https://mainnet-public.mirrornode.hedera.com", [
          "capacity",
          "route",
        ]),
      ],
      notes: [
        "Any HCHF holder can redeem against the lowest-collateral-ratio Troves; HCHF is burned and the protocol transfers face-value HBAR to the redeemer.",
        "supply-full is the eventual system bound, not a guaranteed hot buffer: same-block capacity depends on current open Troves and their collateral.",
        "The fee is dynamic and should be read from the deployed contract's current fee state/formula rather than treated as a fixed numeric charge.",
      ],
    }),
    "euro3-3a-dao": defineCollateralConfig({
      outputAssetType: "mixed-collateral",
      outputAssets: [
        "asset:wmatic",
        "asset:usdc.e",
        "asset:weth",
        "asset:wbtc",
        "asset:wsteth",
        "asset:dai",
        "asset:meusdc",
        "asset:meusdt",
        "asset:meweth",
        "asset:mewsteth",
        "asset:mewbtc",
      ],
      capacityModel: {
        kind: "supply-ratio",
        ratio: 0.40290081,
        confidence: "heuristic",
        basis: "full-system-eventual",
      },
      costModel: documentedVariableFee(
        "3A DAO's redemption fee is governance-settable; live Polygon and Linea factory reads returned redemptionRate 0, so the reviewed current fee is 0 bps but can change with governance",
        "formula",
      ),
      reviewedAt: "2026-08-13",
      docs: [
        sourceRef("3A DAO redemptions", "https://docs.3adao.org/3a-protocol/protocol-documentation/lending/redemptions", [
          "route",
          "access",
          "fees",
        ]),
        sourceRef(
          "3A DAO collateral interaction reference",
          "https://docs.3adao.org/3a-protocol/technical-documentation/smart-contracts/interacting-with-contracts/adding-and-removing-collateral",
          ["route", "settlement"],
        ),
        sourceRef("3A DAO EURO3 price stability", "https://docs.3adao.org/3a-protocol/protocol-documentation/euro3-coin/euro3-price-stability", [
          "route",
        ]),
        sourceRef(
          "Polygon contract registry",
          "https://docs.3adao.org/3a-protocol/technical-documentation/smart-contracts/polygon-mainnet-contracts",
          ["route", "access"],
        ),
        sourceRef(
          "Linea contract registry",
          "https://docs.3adao.org/3a-protocol/technical-documentation/smart-contracts/linea-mainnet-contracts",
          ["route", "access"],
        ),
        sourceRef("Polygon EURO3 token RPC", "https://polygon-rpc.com", ["capacity"]),
        sourceRef("Linea EURO3 token and factory RPC", "https://rpc.linea.build", ["capacity"]),
        sourceRef(
          "Polygon factory verified source",
          "https://repo.sourcify.dev/contracts/full_match/137/0x4760847023fa0833221ae76e01db1e483a5d20e0/sources",
          ["route", "fees", "access"],
        ),
        sourceRef(
          "Linea factory verified source",
          "https://repo.sourcify.dev/contracts/full_match/59144/0x65c6fd9b3a2a892096881e28f07c732ed128893e/sources",
          ["route", "fees", "access"],
        ),
      ],
      notes: [
        "EURO3 holders can deposit EURO3 into another user's eligible vault and receive its collateral less the redemption fee; the route is gated by the vault health-factor condition rather than being a generic issuer buyback.",
        "The 0.40290081 capacity ratio is the reviewed Polygon snapshot of eligible vault debt against total EURO3 debt, so it is a heuristic current-debt share and an eventual-system bound rather than a fixed liquidity guarantee.",
        "The current live Polygon and Linea reads returned redemptionRate 0 (0 bps), while the factory and protocol materials expose a governance-adjustable fee, so the zero-fee observation is not treated as permanent.",
        "The reviewed deployments are Polygon and Linea; Base was not present in the official registries checked and is intentionally not implied by this config.",
      ],
    }),
  }),
];

const FINALIZED_COLLATERAL_REDEEM_BACKSTOP_REGISTRY = finalizeBackstopRegistry(
  COLLATERAL_REDEEM_REGISTRY_ENTRIES,
  [
    {
      stablecoinIds: [
        "feusd-felix",
        "meusd-mezo",
        "nect-beraborrow",
        "usdq-quill",
        "usdaf-asymmetry",
        "reusd-resupply",
        "satusd-river",
      ],
    },
    { stablecoinIds: ["ussd-sonic-labs", "usdp-parallel"], reviewedAt: REVIEWED_REMEDIATION_AT },
    { stablecoinIds: ["hbd-hive"], reviewedAt: REVIEWED_HIVE_HBD_AT },
  ],
);

export const COLLATERAL_REDEEM_BACKSTOP_ENTRIES = FINALIZED_COLLATERAL_REDEEM_BACKSTOP_REGISTRY.entries;
