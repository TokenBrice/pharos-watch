import { documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const WSRUSD_RESERVOIR_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  executionModel: "rules-based-nav",
  capacityModel: {
    kind: "reserve-sync-metadata",
    fallbackRatio: 0.0025,
    confidence: "documented-bound",
    basis: "hot-buffer",
  },
  costModel: documentedVariableFee("ERC-4626 unwrap to rUSD, then PSM exit to USDC; no separate fee disclosed"),
  reviewedAt: "2026-04-04",
  docs: [
    sourceRef("Reservoir Savings (srUSD)", "https://docs.reservoir.xyz/products/savings-srusd", ["route", "capacity"]),
    sourceRef(
      "Reservoir Peg Stability Module",
      "https://docs.reservoir.xyz/protocol-architecture/peg-stability-module",
      ["route", "capacity"],
    ),
    sourceRef("Reservoir Proof of Reserves", "https://docs.reservoir.xyz/products/proof-of-reserves", ["capacity"]),
  ],
  notes: [
    "Fresh live reserve telemetry uses the current USDC position as the immediate redeemable lower bound",
    "When the timestamp-less Reservoir balance-sheet feed cannot meet scoring-grade freshness requirements, the route falls back to the reviewed 25 bps minimum USDC PSM balance documented by Reservoir",
  ],
});
