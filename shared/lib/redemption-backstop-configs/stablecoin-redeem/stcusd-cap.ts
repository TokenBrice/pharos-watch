import { undisclosedReviewedFee, type RedemptionBackstopConfig, sourceRef, stablecoinRedeemBase } from "../shared";

export const STCUSD_CAP_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "stcUSD withdraws to cUSD at the live vault exchange rate; public docs reviewed do not publish a separate fixed stcUSD redemption fee",
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
};
