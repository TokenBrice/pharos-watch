import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_WRAPPER_REDEMPTION_AT } from "./shared";

export const SFRXUSD_FRAX_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  docs: [
    sourceRef("Frax sfrxUSD docs", "https://docs.frax.com/protocol/assets/frxusd/sfrxusd", ["route", "capacity"]),
    sourceRef("Frax frxUSD addresses", "https://docs.frax.com/protocol/assets/frxusd/addresses", ["route"]),
  ],
  notes: [
    "sfrxUSD is an ERC-4626-like savings wrapper over frxUSD and exits immediately back into the underlying at the current exchange rate",
    "The wrapper does not add a separate queue or access gate beyond the base frxUSD system",
  ],
};
