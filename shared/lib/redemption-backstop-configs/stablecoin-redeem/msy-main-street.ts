import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const MSY_MAIN_STREET_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  executionModel: "rules-based-nav",
  totalScoreCap: 65,
  costModel: documentedVariableFee(NO_PUBLIC_NUMERIC_REDEMPTION_FEE),
  docs: [
    sourceRef("Main Street staking model", "https://mainstreet-finance.gitbook.io/mainstreet.finance/staking-model", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Main Street msY vault", "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/strategy-vaults/msy-the-options-box-spread", ["route", "capacity"]),
    sourceRef("Main Street redemption process", "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/redemption-process", ["route", "capacity", "settlement"]),
  ],
  notes: [
    "msY exits to msUSD at the live staking exchange rate; final USDC redemption inherits Main Street's primary-market capacity limits and cooldown.",
    "Config-level cap reflects that the wrapper exit alone does not return holders to USDC, and downstream msUSD redemption can be capped or delayed during strategy unwinds.",
  ],
};
