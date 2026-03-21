import type { RedemptionBackstopConfig } from "./shared";
import { documentedVariableFee, fixedFee, NO_PUBLIC_NUMERIC_REDEMPTION_FEE, queueRedeemBase } from "./shared";

export const QUEUE_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "alusd-alchemix": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.3 },
    costModel: documentedVariableFee("1:1 via the Transmuter; no separate redemption fee is disclosed"),
  },
  "iusd-infinifi": {
    ...queueRedeemBase,
    capacityModel: {
      kind: "reserve-sync-metadata",
      fallbackRatio: 0.15,
    },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "reusd-re-protocol": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.2 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "cgusd-cygnus-finance": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.15 },
    costModel: documentedVariableFee("Docs describe 1:1 redemption if fees are excluded; current fee is not disclosed"),
  },
  "uty-xsy": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.3 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "usp-pikudao": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1 },
    costModel: fixedFee(20, "Piku docs list a 20 bps redemption fee"),
  },
  "aznd-mu-digital": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1 },
    costModel: fixedFee(0, "Mu Digital docs describe minting and redemption as fee-free"),
  },
  "avusd-avant": {
    ...queueRedeemBase,
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1 },
    costModel: documentedVariableFee("Avant docs say the redemption fee is shown in-app before confirmation"),
  },
  "usdu-unitas": {
    ...queueRedeemBase,
    accessModel: "issuer-api",
    settlementModel: "same-day",
    capacityModel: { kind: "supply-ratio", ratio: 0.05 },
    costModel: fixedFee(0, "Unitas docs list a 0% redemption fee"),
  },
  "yzusd-yuzu": {
    ...queueRedeemBase,
    accessModel: "issuer-api",
    settlementModel: "days",
    capacityModel: { kind: "supply-ratio", ratio: 0.1 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "nusd-neutrl": {
    ...queueRedeemBase,
    capacityModel: { kind: "supply-ratio", ratio: 0.2 },
    costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  },
  "usdai-usd-ai": {
    ...queueRedeemBase,
    costModel: documentedVariableFee(
      "Redeemable 1:1 in fixed 30-day processing windows; QEV auction mechanism manages redemptions against illiquid collateral",
    ),
  },
};
