import { documentedBoundSupplyFull, documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const SUSN_NOON_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
  capacityModel: { kind: "reserve-sync-metadata" },
  accessModel: "whitelisted-onchain",
  executionModel: "rules-based-nav",
  totalScoreCap: 65,
  costModel: documentedVariableFee("sUSN exits to USN; final USN mint/redeem routes are whitelisted and depend on supported stablecoin liquidity"),
  docs: [
    sourceRef("Noon USN and sUSN", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Noon minting and redemption", "https://docs.noon.capital/built-for-high-yields/our-stablecoin-usn-and-susn/minting-and-redemption", ["route", "access"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USN balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
