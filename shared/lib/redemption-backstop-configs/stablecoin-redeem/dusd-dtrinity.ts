import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const DUSD_DTRINITY_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  executionModel: "deterministic-basket",
  outputAssetType: "stable-basket",
  capacityModel: { kind: "supply-ratio", ratio: 0.4, confidence: "heuristic", basis: "strategy-buffer" },
  costModel: fixedFee(50, "Protocol docs describe redemption fees of up to 50 bps"),
  reviewedAt: "2026-04-16",
  docs: [
    sourceRef("dTrinity documentation", "https://docs.dtrinity.org/", ["route", "capacity", "fees"]),
  ],
  notes: [
    "The 40% ratio is a reviewed heuristic reflecting tracked stable-bucket share rather than a published instant-liquidity floor",
  ],
});
