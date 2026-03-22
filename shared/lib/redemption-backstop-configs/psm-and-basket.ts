import type { RedemptionBackstopConfig } from "./shared";
import {
  basketRedeemBase,
  documentedVariableFee,
  fixedFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  psmSwapBase,
  sourceRef,
} from "./shared";

export const PSM_AND_BASKET_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "cusd-cap": {
    ...basketRedeemBase,
    costModel: documentedVariableFee("Fixed redemption fee, but public docs do not publish the current rate"),
  },
  "dai-makerdao": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.33 },
    costModel: fixedFee(0, "LitePSM docs show fees are not activated for DAI <-> USDC"),
  },
  "usds-sky": {
    ...psmSwapBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.33 },
    costModel: fixedFee(
      0,
      "USDS uses the LitePSMWrapper-USDS-USDC route, and Sky docs show LitePSM fees are not activated for the underlying DAI <-> USDC leg",
    ),
    notes: [
      "USDS <-> USDC routes through LitePSMWrapper-USDS-USDC and the fee-free DAI <-> USDS converter, so it shares the same LitePSM liquidity path as DAI",
    ],
  },
  "gho-aave": {
    ...psmSwapBase,
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(10, "GSM exit fee is governance-set; recent Aave docs show roughly 8-10 bps on redemption"),
    reviewedAt: "2026-03-22",
    docs: [
      sourceRef("Aave GHO", "https://aave.com/gho", ["route", "capacity", "fees"]),
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
    costModel: documentedVariableFee(
      "Reserve Index docs describe mint and TVL fees, but do not document a separate redemption fee",
    ),
    notes: [
      "Redemption requires receiving the underlying basket composition rather than selecting a single stablecoin output",
    ],
  },
};
