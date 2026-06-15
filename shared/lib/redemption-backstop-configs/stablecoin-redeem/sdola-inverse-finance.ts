import { documentedBoundSupplyFull, fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const SDOLA_INVERSE_FINANCE_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull("2026-05-24"),
  capacityModel: { kind: "reserve-sync-metadata" },
  totalScoreCap: 70,
  costModel: fixedFee(
    0,
    "sDOLA docs describe permissionless instant unwrapping back to DOLA with no lock-up period or early-withdrawal penalty.",
  ),
  docs: [
    sourceRef("sDOLA docs", "https://docs.inverse.finance/inverse-finance/inverse-finance/products/tokens/dola/sdola", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef(
      "Inverse Peg Stability Module",
      "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module",
      ["route", "capacity", "fees"],
    ),
  ],
  notes: [
    "Modeled route is the permissionless sDOLA wrapper exit into DOLA, not the downstream DOLA-to-USDS PSM path.",
    "Config-level cap reflects that unwrapping to DOLA does not by itself guarantee a full stablecoin exit; DOLA's own PSM capacity remains separately bounded.",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle DOLA balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
