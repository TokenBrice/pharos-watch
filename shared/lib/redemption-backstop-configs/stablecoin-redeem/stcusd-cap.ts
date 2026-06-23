import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const STCUSD_CAP_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(
    0,
    "stcUSD unstakes to cUSD fee-free at the live vault exchange rate (only accrued-yield/lockedProfit NAV growth, no separate stcUSD wrapper fee); the 0.25% (0% whitelisted) fee is the downstream cUSD mint/burn/redeem leg, not the stcUSD step",
  ),
  reviewedAt: "2026-05-17",
  docs: [
    sourceRef("Cap stcUSD mechanics", "https://docs.cap.app/protocol-overview/stcusd-mechanics", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef("Cap cUSD mechanics", "https://docs.cap.app/protocol-overview/cusd-mechanics", ["route", "capacity"]),
    sourceRef("Cap vault", "https://docs.cap.app/concepts/vault", ["route", "capacity", "fees"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the vault's idle cUSD balance as current direct wrapper capacity; final cUSD par exit inherits Cap's proportional reserve-basket redemption route.",
  ],
});
