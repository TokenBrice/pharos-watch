import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const SRUSD_RESERVOIR_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: {
    kind: "reserve-sync-metadata",
    fallbackRatio: 0.0025,
    confidence: "documented-bound",
    basis: "hot-buffer",
  },
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("srUSD exits to rUSD, then Reservoir PSM liquidity provides stablecoin redemption when available"),
  reviewedAt: "2026-05-17",
  docs: [
    sourceRef("Reservoir Savings (srUSD)", "https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef(
      "Reservoir Peg Stability Module",
      "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
      ["route", "capacity"],
    ),
    sourceRef("Reservoir Proof of Reserves", "https://docs.reservoir.xyz/products/proof-of-reserves", ["capacity"]),
  ],
  notes: [
    "Fresh reserve telemetry uses Reservoir's balance-sheet feed; when it is unavailable, the route falls back to Reservoir's documented 25 bps minimum USDC PSM balance",
  ],
};
