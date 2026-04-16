import type { RedemptionBackstopConfig } from "./shared";
import {
  applyTrackedReviewedDocs,
  basketRedeemBase,
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  psmSwapBase,
  sourceRef,
} from "./shared";

const REVIEWED_BASKET_REDEMPTION_AT = "2026-03-23";
const REVIEWED_REMEDIATION_AT = "2026-03-30";
const REVIEWED_ROUTE_TUNING_AT = "2026-04-04";
const reviewedBasketRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_BASKET_REDEMPTION_AT,
);

export const PSM_AND_BASKET_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "cusd-cap": {
    ...basketRedeemBase,
    ...reviewedBasketRedemptionSupplyFull,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: documentedVariableFee("Fixed redemption fee, but public docs do not publish the current rate"),
    docs: [
      sourceRef("Cap introduction", "https://docs.cap.app/", ["route", "capacity"]),
      sourceRef(
        "Cap cUSD mechanics",
        "https://docs.cap.app/protocol-overview/cusd-mechanics",
        ["route", "capacity"],
      ),
      sourceRef("Cap vault", "https://docs.cap.app/concepts/vault", ["route", "capacity", "fees"]),
      sourceRef("Cap risks", "https://docs.cap.app/risks", ["capacity", "settlement"]),
    ],
    notes: [
      "Cap docs describe cUSD as always redeemable against the underlying reserve basket, with dynamic interest rates preventing full utilization so withdrawals remain atomic",
    ],
  },
  "honey-berachain": {
    ...basketRedeemBase,
    ...reviewedBasketRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Normal redemptions are asset-specific: 0 bps for USDT/byUSD and 5 bps for USDC/USDe; stress Basket Mode returns a proportional collateral basket instead",
    ),
    docs: [
      sourceRef(
        "Berachain Honey docs",
        "https://docs.berachain.com/general/tokens/honey",
        ["route", "capacity", "fees"],
      ),
    ],
    notes: [
      "Modeled against Basket Mode because the stress-state redemption path turns exits into proportional basket withdrawals when collateral becomes unstable",
    ],
  },
  "dai-makerdao": {
    ...psmSwapBase,
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.33 },
    costModel: fixedFee(0, "LitePSM docs show fees are not activated for DAI <-> USDC"),
    notes: [
      "Fresh Sky reserve telemetry uses current PSM USDC balance as immediate capacity; fallback retains the reviewed 33% heuristic when live metadata is unavailable",
    ],
  },
  "usds-sky": {
    ...psmSwapBase,
    capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.33 },
    costModel: fixedFee(
      0,
      "USDS uses the LitePSMWrapper-USDS-USDC route, and Sky docs show LitePSM fees are not activated for the underlying DAI <-> USDC leg",
    ),
    notes: [
      "Fresh Sky reserve telemetry uses current PSM USDC balance as immediate capacity; fallback retains the reviewed 33% heuristic when live metadata is unavailable",
      "USDS <-> USDC routes through LitePSMWrapper-USDS-USDC and the fee-free DAI <-> USDS converter, so it shares the same LitePSM liquidity path as DAI",
    ],
  },
  "gho-aave": {
    ...psmSwapBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      10,
      "Fresh live mainnet GSM telemetry uses the current worst tracked buy fee; the reviewed fallback bound is 10 bps when telemetry is unavailable",
    ),
    reviewedAt: REVIEWED_ROUTE_TUNING_AT,
    docs: [
      sourceRef("Aave Stability Module", "https://aave.com/help/gho-stablecoin/stability-module", ["route", "fees"]),
    ],
    notes: [
      "Immediate capacity is sourced from live tracked mainnet GSM backing and excludes frozen or seized modules at runtime",
      "When reserve sync is degraded only because residual GHO issuance remains outside configured GSM modules, redemption still uses the tracked swappable GSM backing as a conservative live lower bound instead of dropping the route entirely",
    ],
  },
  "usdd-tron-dao-reserve": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.16, confidence: "documented-bound" },
    costModel: fixedFee(0, "USDD docs describe 1:1 PSM conversions between USDD and USDT/USDC/TUSD"),
    reviewedAt: REVIEWED_BASKET_REDEMPTION_AT,
    docs: [
      sourceRef("USDD documentation", "https://docs.usdd.io", ["route", "capacity", "fees"]),
      sourceRef("USDD website", "https://usdd.io/", ["capacity"]),
    ],
    notes: [
      "The reviewed 16% bound matches the tracked USDT PSM reserve share and does not claim the full collateralized USDD system is instantly redeemable through the PSM",
    ],
  },
  "dola-inverse-finance": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.08, confidence: "documented-bound" },
    costModel: fixedFee(20, "Inverse FiRM docs list a 20 bps DOLA -> USDS exit fee"),
    reviewedAt: "2026-03-23",
    docs: [
      sourceRef(
        "Inverse Peg Stability Module",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module",
        ["route", "capacity", "fees"],
      ),
      sourceRef("Inverse Finance transparency", "https://www.inverse.finance/transparency", ["capacity"]),
    ],
    notes: [
      "Modeled against the documented USDS PSM floor rather than full-system FiRM debt unwinds; the reviewed 8% bound matches the currently published PSM share of reserves and does not claim full DOLA supply is instantly redeemable",
    ],
  },
  "buck-bucket-protocol": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.25, confidence: "documented-bound" },
    costModel: fixedFee(30, "Modeled route uses PSM OUT at 30 bps; collateral redemptions use a separate dynamic fee"),
    reviewedAt: REVIEWED_BASKET_REDEMPTION_AT,
    docs: [
      sourceRef("Bucket Protocol docs", "https://docs.bucketprotocol.io/", ["route", "capacity", "fees"]),
    ],
    notes: [
      "The reviewed 25% bound matches the tracked USDC/USDT PSM reserve share rather than assuming the full BUCK supply is instantly redeemable through the stablecoin module",
    ],
  },
  "lisusd-lista": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15, confidence: "documented-bound" },
    costModel: fixedFee(
      200,
      "Lista docs list a 2% fee on lisUSD -> centralized stablecoin conversions and a 500,000 lisUSD daily redemption limit",
    ),
    reviewedAt: REVIEWED_BASKET_REDEMPTION_AT,
    docs: [
      sourceRef("Lista docs", "https://docs.bsc.lista.org", ["route", "capacity", "fees"]),
      sourceRef("Lista website", "https://lista.org/", ["route"]),
    ],
    notes: [
      "Docs also publish a 500,000 lisUSD daily redemption limit for PSM exits",
      "The reviewed 15% bound matches the tracked centralized-stablecoin PSM share rather than assuming the CDP-backed portion is instantly redeemable through the PSM",
    ],
  },
  "dusd-alto": {
    ...psmSwapBase,
    costModel: fixedFee(
      20,
      "Alto docs describe a 0.20% (20 bps) fee on both PSM swap directions; PSM capacity is capped at 5M USDC which currently exceeds total DUSD supply",
    ),
  },
  "silk-shade-protocol": {
    ...basketRedeemBase,
    ...documentedBoundSupplyFull("2026-04-16"),
    outputAssetType: "mixed-collateral",
    costModel: documentedVariableFee(
      "Shade Protocol documents Silk redemption pools plus ShadeDAO bond-assisted arbitrage; public docs reviewed do not publish a single fixed bps redemption fee",
    ),
    docs: [
      sourceRef("Shade Protocol Silk docs", "https://docs.shadeprotocol.io/silk", ["route", "capacity"]),
    ],
    notes: [
      "Silk tracks a basket of GDP-weighted currencies; redemption pools combined with ShadeLend overcollateralization provide a reviewed basket-exit rail rather than a single-stable PSM",
      "Output asset type is mixed-collateral because the redeemed basket is not guaranteed to be all-stablecoin; it can include native Shade collateral assets",
    ],
  },
  "eusd-electronic-usd": {
    ...basketRedeemBase,
    ...reviewedBasketRedemptionSupplyFull,
    costModel: documentedVariableFee(
      "Reserve Index docs describe mint and TVL fees, but do not document a separate redemption fee",
    ),
    docs: [
      sourceRef(
        "Reserve Index minting & redeeming",
        "https://docs.reserve.org/reserve-index/mint-redeem",
        ["route", "capacity", "access"],
      ),
      sourceRef("Reserve Index fees", "https://docs.reserve.org/reserve-index/fees", ["fees"]),
      sourceRef(
        "Reserve Electronic USD overview",
        "https://app.reserve.org/ethereum/token/0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f/overview",
        ["capacity"],
      ),
    ],
    notes: [
      "Redemption requires receiving the underlying basket composition rather than selecting a single stablecoin output",
    ],
  },
};

applyTrackedReviewedDocs(PSM_AND_BASKET_BACKSTOP_CONFIGS, ["dai-makerdao", "usds-sky", "dusd-alto"], REVIEWED_REMEDIATION_AT);
