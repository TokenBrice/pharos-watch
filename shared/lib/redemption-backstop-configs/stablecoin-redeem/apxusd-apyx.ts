import { documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, reviewedDirectRedemptionSupplyFull } from "./shared";

export const APXUSD_APYX_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...reviewedDirectRedemptionSupplyFull,
  accessModel: "whitelisted-onchain",
  costModel: documentedVariableFee(
    "Apyx docs describe mint and redeem against approved assets for whitelisted participants, with offchain execution spreads and expenses reflected in the price rather than a fixed protocol fee",
  ),
  docs: [
    sourceRef(
      "How to Buy apxUSD",
      "https://docs.apyx.fi/app-guide/how-to-buy-apxusd",
      ["route", "access"],
    ),
    sourceRef(
      "How Apyx Works",
      "https://docs.apyx.fi/apyx-overview/how-apyx-works",
      ["route", "capacity", "fees"],
    ),
    sourceRef(
      "Peg Stability Model",
      "https://docs.apyx.fi/solution-overview/peg-stability-model",
      ["route", "capacity"],
    ),
  ],
  notes: ["Retail users primarily access apxUSD via the Curve pool, while direct minting and redemption are reserved for whitelisted participants who rebalance the market"],
});
