import {
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const SCRVUSD_CURVE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(),
  reviewedAt: "2026-05-17",
  docs: [
    sourceRef("Curve scrvUSD month-in-review", "https://news.curve.finance/savings-crvusd-a-month-in-review/", ["route", "capacity"]),
    sourceRef("Curve resources", "https://resources.curve.finance/", ["route"]),
  ],
  notes: [
    "scrvUSD is Curve's savings wrapper over crvUSD and exits into the underlying at the live vault exchange rate",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle crvUSD balance as current direct wrapper capacity; actual par-exit quality then depends on the underlying crvUSD redemption and peg-defense surface.",
  ],
};
