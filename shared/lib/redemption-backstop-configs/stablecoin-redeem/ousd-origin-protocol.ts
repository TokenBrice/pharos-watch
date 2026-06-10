import {
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";

export const OUSD_ORIGIN_PROTOCOL_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...reviewedDirectRedemptionSupplyFull,
  capacityModel: { kind: "reserve-sync-metadata" },
  costModel: fixedFee(25, "Origin docs list a 0.25% exit fee on OUSD redemptions"),
  docs: [
    sourceRef(
      "Origin Dollar (OUSD)",
      "https://docs.originprotocol.com/yield-bearing-tokens/origin-dollar-ousd",
      ["route", "capacity"],
    ),
    sourceRef(
      "Origin March 2023 token holder update",
      "https://www.originprotocol.com/blog/march-2023-token-holder-update?lang=en",
      ["route", "fees"],
    ),
    sourceRef(
      "Origin pricing and peg management",
      "https://docs.originprotocol.com/security-and-risk/price-oracles",
      ["route", "capacity"],
    ),
  ],
  notes: [
    "Origin docs still describe pro-rata basket redemption semantics; current OUSD collateral is USDC only",
    "Fresh Origin vault telemetry reads the vault's idle stablecoin balances as current direct redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
};
