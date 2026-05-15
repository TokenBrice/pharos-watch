import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_WRAPPER_REDEMPTION_AT } from "./shared";

export const SCRVUSD_CURVE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  docs: [
    sourceRef("Curve scrvUSD month-in-review", "https://news.curve.finance/savings-crvusd-a-month-in-review/", ["route", "capacity"]),
    sourceRef("Curve resources", "https://resources.curve.finance/", ["route"]),
  ],
  notes: [
    "scrvUSD is Curve's savings wrapper over crvUSD and exits into the underlying at the live vault exchange rate",
    "The wrapper route is immediate; actual par-exit quality then depends on the underlying crvUSD redemption and peg-defense surface",
  ],
};
