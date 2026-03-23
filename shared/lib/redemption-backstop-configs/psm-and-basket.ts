import type { RedemptionBackstopConfig } from "./shared";
import {
  basketRedeemBase,
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  psmSwapBase,
  sourceRef,
} from "./shared";

const REVIEWED_BASKET_REDEMPTION_AT = "2026-03-23";
const reviewedBasketRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_BASKET_REDEMPTION_AT,
);

export const PSM_AND_BASKET_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "cusd-cap": {
    ...basketRedeemBase,
    ...reviewedBasketRedemptionSupplyFull,
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
    reviewedAt: "2026-03-22",
    docs: [
      sourceRef("Aave Stability Module", "https://aave.com/help/gho-stablecoin/stability-module", ["route", "fees"]),
    ],
    notes: [
      "Immediate capacity is sourced from live onchain mainnet GSM backing and excludes frozen or seized modules at runtime",
    ],
  },
  "usdd-tron-dao-reserve": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.16 },
    costModel: fixedFee(0, "USDD docs describe 1:1 PSM conversions between USDD and USDT/USDC/TUSD"),
  },
  "dola-inverse-finance": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.08 },
    costModel: fixedFee(20, "Inverse FiRM docs list a 20 bps DOLA -> USDS exit fee"),
  },
  "buck-bucket-protocol": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.25 },
    costModel: fixedFee(30, "Modeled route uses PSM OUT at 30 bps; collateral redemptions use a separate dynamic fee"),
  },
  "hollar-hydrated": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "lisusd-lista": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: fixedFee(
      200,
      "Lista docs list a 2% fee on lisUSD -> centralized stablecoin conversions and a 500,000 lisUSD daily redemption limit",
    ),
    notes: ["Docs also publish a 500,000 lisUSD daily redemption limit for PSM exits"],
  },
  "dusd-alto": {
    ...psmSwapBase,
    costModel: fixedFee(
      20,
      "Alto docs describe a 0.20% (20 bps) fee on both PSM swap directions; PSM capacity is capped at 5M USDC which currently exceeds total DUSD supply",
    ),
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
