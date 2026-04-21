import type { RedemptionBackstopConfig } from "./shared";
import {
  applyTrackedReviewedDocs,
  collateralRedeemBase,
  documentedBoundSupplyFull,
  documentedVariableFee,
  expandIds,
  fixedFee,
  LIQUITY_STYLE_REDEMPTION_FEE,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  sourceRef,
} from "./shared";

const REVIEWED_DIRECT_REDEMPTION_AT = "2026-03-23";
const REVIEWED_REMEDIATION_AT = "2026-03-30";
const reviewedDirectRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_DIRECT_REDEMPTION_AT,
);

export const COLLATERAL_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  ...expandIds(
    ["bold-liquity", "lusd-liquity", "feusd-felix", "meusd-mezo", "nect-beraborrow", "fxusd-f-x-protocol", "usdq-quill", "usdk-orki"],
    collateralRedeemBase,
  ),
  "bold-liquity": {
    ...collateralRedeemBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
    reviewedAt: "2026-03-22",
    docs: [
      sourceRef("Liquity V2 redemption docs", "https://docs.liquity.org/v2-faq/redemptions-and-delegation", ["route", "capacity", "fees"]),
      sourceRef("Liquity v2 repository", "https://github.com/liquity/bold", ["route", "capacity", "fees"]),
    ],
    notes: [
      "Fresh live reserve metadata reads Liquity v2 ActivePool branch debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
    ],
  },
  "lusd-liquity": {
    ...collateralRedeemBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
    reviewedAt: "2026-03-22",
    docs: [
      sourceRef("Liquity redemption docs", "https://docs.liquity.org/liquity-v1/faq/lusd-redemptions", ["route", "capacity", "fees"]),
      sourceRef("Liquity v1 contract addresses", "https://docs.liquity.org/liquity-v1/documentation/resources", ["capacity"]),
    ],
    notes: [
      "Fresh live reserve metadata reads Liquity v1 TroveManager system debt as the current direct redemption-capacity bound; if that on-chain snapshot is unavailable, the route is left unrated instead of using a full-supply fallback",
    ],
  },
  "feusd-felix": {
    ...collateralRedeemBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    costModel: fixedFee(0, "Felix docs describe redemption as fee-free"),
  },
  "meusd-mezo": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: fixedFee(75, "75 bps standard; 0 bps when redeeming against your own debt"),
  },
  "nect-beraborrow": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "fxusd-f-x-protocol": {
    ...collateralRedeemBase,
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
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "usnd-nerite": {
    ...collateralRedeemBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "usdq-quill": {
    ...collateralRedeemBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
  },
  "usdk-orki": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(LIQUITY_STYLE_REDEMPTION_FEE, "formula"),
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
      sourceRef("Alloy vault docs", "https://docs.alloy.tether.to/alloy-by-tether/alloy-by-tether-vaults", ["route", "capacity"]),
      sourceRef("Alloy aUSDT mint docs", "https://docs.alloy.tether.to/alloy-by-tether/alloy-by-tether-vaults/ausdmnt", ["route", "fees"]),
      sourceRef("Alloy Ethereum deployments", "https://dev.alloy.tether.to/deployments/ethereum-mainnet", ["capacity"]),
    ],
    notes: [
      "A holder needs Alloy verification and usable CMP collateral access to exercise the onchain return path; route scoring reflects whitelisted collateral redemption rather than public fiat redemption",
      "Live reserve sync reads the current XAUT vault balance and aUSDT total supply, but current redemption capacity is still modeled as documented eventual system redeemability until Alloy exposes per-account/current redeemable-capacity telemetry",
    ],
  },
  "ebusd-ebisu": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "ussd-sonic-labs": {
    ...collateralRedeemBase,
    outputAssetType: "stable-single",
    costModel: fixedFee(0, "Zero minting and redemption fees per Sonic Labs documentation"),
  },
  "reusd-resupply": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: fixedFee(100, "Communal redemption model with 1% fee establishing a price floor"),
  },
  "cusd-celo": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Mento AMM burn-to-redeem against reserve assets at oracle rate; circuit breakers enforce safety bounds",
    ),
    docs: [
      sourceRef("Mento reserve docs", "https://docs.mento.org/mento/overview/core-concepts/the-reserve", ["route", "capacity"]),
      sourceRef("Mento reserve dashboard", "https://reserve.mento.org/", ["capacity"]),
    ],
    notes: [
      "Mento docs describe cUSD as mintable by depositing reserve collateral and burnable back into reserve assets at oracle value, with overcollateralization and circuit breakers governing the reserve",
    ],
  },
  "ceur-celo": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "BiPoolManager virtual AMM on Celo; mint/burn against reserve assets at oracle-enforced EUR rate; circuit breaker limits",
    ),
    docs: [
      sourceRef("Mento reserve docs", "https://docs.mento.org/mento/overview/core-concepts/the-reserve", ["route", "capacity"]),
      sourceRef("Mento reserve dashboard", "https://reserve.mento.org/", ["capacity"]),
    ],
    notes: [
      "Mento docs describe cEUR as mintable by depositing reserve collateral and burnable back into reserve assets at oracle value, with overcollateralization and circuit breakers governing the reserve",
    ],
  },
  "usdp-parallel": {
    ...collateralRedeemBase,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Parallelizer module: dynamic minting/burning fees adjust to correct peg deviations; depeg penalty applied proportionally",
    ),
  },
  "satusd-river": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Omni-CDP with $1-of-collateral redemption arbitrage; public fee schedule not disclosed",
    ),
  },
  "doc-money-on-chain": {
    ...collateralRedeemBase,
    ...documentedBoundSupplyFull("2026-04-21"),
    costModel: documentedVariableFee(
      "Money On Chain docs describe permissionless DOC redemption into RBTC, but the reviewed public materials do not publish a single fixed numeric redemption fee schedule",
    ),
    docs: [
      sourceRef("DOC overview", "https://moneyonchain.com/doc-stablecoin/", ["route"]),
      sourceRef("Money On Chain main concepts", "https://docs.moneyonchain.com/main-rbtc-contract/money-on-chain-platform/main-concepts", ["route", "capacity"]),
      sourceRef("Redeeming DOCs", "https://docs.moneyonchain.com/main-rbtc-contract/integration-with-moc-platform/getting-docs/redeeming-docs", ["route", "fees"]),
    ],
    notes: [
      "Money On Chain documents a permissionless DOC -> RBTC redemption path for the BTC-backed system, so Pharos models the direct collateral exit rather than relying only on secondary-market liquidity",
      "The current route remains documented-bound until a dedicated Rootstock reserve adapter exposes fresh current protocol capacity and fee telemetry",
    ],
  },
  "usbd-bima": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Redemption fee = coreRate + 75 bps; coreRate rises with redeemed supply and decays with a 24-hour half-life",
      "formula",
    ),
    docs: [
      sourceRef("BIMA redeeming USBD", "https://docs.bima.money/redeeming-usbd", ["route", "capacity", "fees"]),
      sourceRef(
        "BIMA risk management + liquidations",
        "https://docs.bima.money/risk-management-+-liquidations",
        ["capacity"],
      ),
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
  "fpi-frax": {
    ...collateralRedeemBase,
    ...reviewedDirectRedemptionSupplyFull,
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "CPI-indexed redemption price grows on-chain per second at 12-month US CPI-U rate; 100% collateral ratio maintained via AMOs",
    ),
    docs: [
      sourceRef("Frax Price Index overview", "https://docs.frax.finance/frax-price-index/overview-cpi-peg-and-mechanics", ["route", "capacity"]),
      sourceRef("Frax website", "https://frax.com/", ["route"]),
    ],
    notes: [
      "Tracked metadata describes FPI as redeemable against a fully collateralized FRAX-backed system with the redemption price moving on-chain with CPI rather than staying fixed at $1",
    ],
  },
};

applyTrackedReviewedDocs(COLLATERAL_REDEEM_BACKSTOP_CONFIGS, [
  "feusd-felix",
  "meusd-mezo",
  "nect-beraborrow",
  "usdq-quill",
  "usdk-orki",
  "usdaf-asymmetry",
  "usnd-nerite",
  "ebusd-ebisu",
  "reusd-resupply",
  "satusd-river",
]);

applyTrackedReviewedDocs(COLLATERAL_REDEEM_BACKSTOP_CONFIGS, ["ussd-sonic-labs", "usdp-parallel"], REVIEWED_REMEDIATION_AT);
