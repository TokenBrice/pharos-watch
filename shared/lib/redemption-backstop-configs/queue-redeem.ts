import type { RedemptionBackstopConfig } from "./shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  fixedFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  queueRedeemBase,
  sourceRef,
} from "./shared";

const REVIEWED_QUEUE_REDEMPTION_AT = "2026-03-23";
const reviewedQueueRedemptionSupplyFull = documentedBoundSupplyFull(
  REVIEWED_QUEUE_REDEMPTION_AT,
);

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
    costModel: fixedFee(0, "Tracked protocol metadata describes 1:1 mint/redeem against USDC with no fees"),
  },
  "usdf-falcon": {
    ...queueRedeemBase,
    accessModel: "whitelisted-onchain",
    capacityModel: { kind: "reserve-sync-metadata" },
    costModel: fixedFee(
      0,
      "Falcon docs state users bear gas and execution costs while Falcon does not charge a separate protocol-specific redemption fee",
    ),
    reviewedAt: "2026-03-23",
    docs: [
      sourceRef(
        "Falcon redeem guide",
        "https://docs.falcon.finance/resources/quick-app-guide/navigating-the-swap-tab/redeem",
        ["route", "settlement", "access"],
      ),
      sourceRef(
        "Falcon FAQ",
        "https://docs.falcon.finance/resources/frequently-asked-questions-faq",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Falcon transparency API",
        "https://api.falcon.finance/api/v1/transparency",
        ["capacity"],
      ),
    ],
    notes: ["Fresh live reserve metadata scores against Falcon's current stablecoin reserve bucket; redeemed assets are still credited only after the documented 7-day cooldown"],
  },
  "syrupusdc-maple": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Maple docs describe FIFO queued withdrawal requests for syrupUSDC and do not publish a separate protocol redemption fee",
    ),
    docs: [
      sourceRef(
        "Maple syrupUSDC / syrupUSDT withdrawals",
        "https://docs.maple.finance/syrupusdc-usdt-for-lenders/risk",
        ["route", "settlement", "fees"],
      ),
      sourceRef(
        "Maple Pools technical reference",
        "https://docs.maple.finance/technical-resources/pools/pools",
        ["route", "access", "settlement"],
      ),
    ],
    notes: [
      "Maple docs describe onchain `requestRedeem` withdrawals entering FIFO queues, with most withdrawals processed in under 24 hours but potentially taking up to 30 days as liquidity becomes available",
      "Modeled route excludes secondary-market exits on Uniswap or Balancer and instead scores the documented protocol withdrawal rail",
    ],
  },
  "syrupusdt-maple": {
    ...queueRedeemBase,
    ...reviewedQueueRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Maple docs describe FIFO queued withdrawal requests for syrupUSDT and do not publish a separate protocol redemption fee",
    ),
    docs: [
      sourceRef(
        "Maple syrupUSDC / syrupUSDT withdrawals",
        "https://docs.maple.finance/syrupusdc-usdt-for-lenders/risk",
        ["route", "settlement", "fees"],
      ),
      sourceRef(
        "Maple Pools technical reference",
        "https://docs.maple.finance/technical-resources/pools/pools",
        ["route", "access", "settlement"],
      ),
    ],
    notes: [
      "Maple docs describe onchain `requestRedeem` withdrawals entering FIFO queues, with most withdrawals processed in under 24 hours but potentially taking up to 30 days as liquidity becomes available",
      "Modeled route excludes secondary-market exits and instead scores the documented protocol withdrawal rail",
    ],
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
    ...reviewedQueueRedemptionSupplyFull,
    accessModel: "whitelisted-onchain",
    costModel: documentedVariableFee(
      "Neutrl redemption is available to whitelisted KYC participants and supports instant or queued execution depending on AssetReserve liquidity; public fee schedule is not disclosed",
    ),
    docs: [
      sourceRef("Neutrl minting", "https://docs.neutrl.fi/protocol-mechanics/minting", ["route", "capacity"]),
      sourceRef("Neutrl redemption", "https://docs.neutrl.fi/protocol-mechanics/redemption", ["route", "capacity", "access"]),
      sourceRef("Neutrl transparency", "https://docs.neutrl.fi/protocol-design/transparency", ["capacity"]),
    ],
    notes: ["Neutrl docs establish a dual-path redemption system with instant execution when AssetReserve liquidity is available and an onchain queued fallback when it is not; current model scores eventual redeemability rather than a separately measured live instant buffer"],
  },
};
