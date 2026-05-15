import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const SUSN_NOON_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
  accessModel: "whitelisted-onchain",
  executionModel: "rules-based-nav",
  totalScoreCap: 65,
  costModel: documentedVariableFee("sUSN exits to USN; final USN mint/redeem routes are whitelisted and depend on supported stablecoin liquidity"),
  docs: [
    sourceRef("Noon USN and sUSN", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Noon minting and redemption", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/minting-and-redemption", ["route", "access"]),
  ],
};
