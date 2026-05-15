import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const SRUSD_RESERVOIR_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.0025 },
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("srUSD exits to rUSD, then Reservoir PSM liquidity provides stablecoin redemption when available"),
  reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
  docs: [
    sourceRef("Reservoir Savings (srUSD)", "https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Reservoir Proof of Reserves", "https://docs.reservoir.xyz/products/proof-of-reserves", ["capacity"]),
  ],
  notes: [
    "Fresh reserve telemetry uses Reservoir's balance-sheet feed; the fallback mirrors the reviewed wsrUSD PSM-buffer bound",
  ],
};
