import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_DIRECT_REDEMPTION_AT } from "./shared";

export const USDE_ETHENA_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  accessModel: "whitelisted-onchain",
  settlementModel: "immediate",
  capacityModel: {
    kind: "reserve-sync-metadata",
    fallbackRatio: 0.005,
    basis: "hot-buffer",
  },
  costModel: fixedFee(
    10,
    "Ethena's public fees API reports mint_fee_bps/redeem_fee_bps = 10 for USDT/USDC benefactors, and the USDe terms and conditions cite a reimbursement charge of 10 basis points",
  ),
  reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
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
    sourceRef(
      "Ethena API documentation overview",
      "https://docs.ethena.fi/api-documentation/overview",
      ["fees"],
    ),
  ],
  notes: [
    "Fresh live reserve metadata scores against Ethena's current Liquid Cash bucket, while the 0.5% fallback ratio reflects the smaller hot-contract stable buffer documented for on-demand redemptions",
  ],
});
