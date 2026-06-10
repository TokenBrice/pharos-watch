import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const USDF_ASTHERUS_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "supply-ratio", ratio: 0.5, confidence: "documented-bound" },
  settlementModel: "days",
  executionModel: "rules-based-nav",
  costModel: fixedFee(10, "Aster FAQ states Aster USDF redemption charges 0.1%; PancakeSwap swap fees apply separately"),
  reviewedAt: "2026-05-14",
  docs: [
    sourceRef("Aster USDF FAQ", "https://docs.asterdex.com/usdf-stablecoin/overview/faqs", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef("Aster USDF page", "https://www.asterdex.com/en/usdf", ["route"]),
  ],
  notes: [
    "Tracked metadata describes 1:1 USDT mint and redeem semantics for USDF",
    "The reviewed 50% bound matches the tracked USDT custody share rather than assuming the strategy-deployed delta-neutral book is instantly withdrawable",
  ],
});
