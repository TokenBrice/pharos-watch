import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_WRAPPER_REDEMPTION_AT } from "./shared";

export const CUSDO_OPENEDEN_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  reviewedAt: REVIEWED_WRAPPER_REDEMPTION_AT,
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(
    0,
    "OpenEden integration docs route cUSDO redeem through the wrapper into USDO at convertToAssets; the separate USDO primary redemption fee is downstream of this wrapper leg.",
  ),
  docs: [
    sourceRef("OpenEden cUSDO token docs", "https://docs.openeden.com/usdo/cusdo-token", ["route", "capacity"]),
    sourceRef("OpenEden integration guide", "https://docs.openeden.com/usdo/developers/integration-guide", ["route"]),
  ],
  notes: [
    "cUSDO is the non-rebasing wrapper over USDO and can be wrapped or unwrapped on demand at the current conversion rate",
    "The wrapper leg is immediate; downstream primary-market USDO redemption remains governed by OpenEden's own issuer flow",
    "Fresh ERC-4626 reserve telemetry reads the wrapper's idle USDO balance as current direct unwrap capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
