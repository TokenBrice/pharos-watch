import { documentedBoundSupplyFull, undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const SBOLD_K3_CAPITAL_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "sBOLD ERC-4626 withdraw/redeem returns BOLD at the vault exchange rate; public docs reviewed do not publish one fixed redemption fee",
  ),
  docs: [
    sourceRef("K3 sBOLD introduction", "https://k3-capital.gitbook.io/sbold/introducing-sbold", ["route", "capacity"]),
    sourceRef("K3 sBOLD technical details", "https://k3-capital.gitbook.io/sbold/technical-details", [
      "route",
      "capacity",
      "fees",
    ]),
    sourceRef("K3 sBOLD interactions", "https://k3-capital.gitbook.io/sbold/technical-details/interactions", [
      "route",
      "capacity",
      "access",
      "settlement",
    ]),
  ],
  notes: [
    "sBOLD exits into BOLD through ERC-4626 withdrawal/redeem mechanics; downstream BOLD par exit remains Liquity's collateral-redemption route.",
    "K3 docs note deposit and withdrawal operations can be temporarily restricted when accumulated collateral exposure exceeds configured operational limits.",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle BOLD balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
