import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const USDE_ETHENA_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  accessModel: "whitelisted-onchain",
  settlementModel: "immediate",
  capacityModel: {
    kind: "reserve-sync-metadata",
    fallbackRatio: 0.005,
  },
  costModel: documentedVariableFee(
    "Ethena docs describe direct USDe redemption for whitelisted mint users at $1 into supported stable assets, with users reimbursing transaction gas and execution costs rather than paying a separate fixed protocol fee",
  ),
  reviewedAt: "2026-03-23",
  docs: [
    sourceRef(
      "Ethena peg arbitrage mechanism",
      "https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism",
      ["route", "capacity", "access"],
    ),
    sourceRef(
      "USDe terms and conditions",
      "https://docs.ethena.fi/resources/usde-terms-and-conditions",
      ["route", "fees", "access"],
    ),
    sourceRef(
      "Ethena collateral API",
      "https://app.ethena.fi/api/positions/current/collateral",
      ["capacity"],
    ),
  ],
  notes: [
    "Fresh live reserve metadata scores against Ethena's current Liquid Cash bucket, while the 0.5% fallback ratio reflects the smaller hot-contract stable buffer documented for on-demand redemptions",
  ],
};
