import { documentedBoundSupplyFull, undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const SDUSD_DTRINITY_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull("2026-06-10"),
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  totalScoreCap: 70,
  costModel: undisclosedReviewedFee(
    "dTRINITY docs describe sdUSD as an ERC-4626 vault redeemable into dUSD at the share exchange rate; public materials reviewed do not publish a separate withdrawal fee",
  ),
  docs: [
    sourceRef("dTRINITY sdUSD docs", "https://docs.dtrinity.org/protocol-components/sdusd", [
      "route",
      "capacity",
      "access",
      "settlement",
    ]),
  ],
  notes: [
    "Modeled route is the permissionless sdUSD wrapper exit into dUSD; staked dUSD is supplied into dLEND, so immediate exits depend on idle vault liquidity rather than full deployed supply.",
    "Config-level cap reflects that unwrapping to dUSD does not by itself guarantee a full stablecoin exit; dUSD's own redemption capacity remains separately bounded.",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle dUSD balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using a full-supply model.",
  ],
});
