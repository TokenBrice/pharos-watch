import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, reviewedDirectRedemptionSupplyFull } from "./shared";

export const FRXUSD_FRAX_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...reviewedDirectRedemptionSupplyFull,
  capacityModel: { kind: "reserve-sync-metadata" },
  costModel: undisclosedReviewedFee(
    "Direct Ethereum mint and redeem contracts support 1:1 conversion between frxUSD and USDC; public docs do not publish a fixed redemption fee",
  ),
  docs: [
    sourceRef("frxUSD mint and redeem overview", "https://docs.frax.com/frxusd/mint-and-redeem-overview", [
      "route",
      "capacity",
    ]),
    sourceRef("frxUSD USDC quickstart", "https://docs.frax.com/frxusd/mint-and-redeem-quickstarts/usdc", ["route"]),
    sourceRef("FraxNetDeposit contract", "https://docs.frax.com/fraxnet/contracts/fraxnetDeposit", [
      "route",
      "capacity",
    ]),
  ],
  notes: [
    "Cross-chain and fiat off-ramp flows exist too, but the modeled backstop focuses on the direct onchain USDC redemption rail",
    "If the Frax balance-sheet snapshot is unavailable or stale, the route is intentionally left unrated rather than falling back to a static heuristic buffer",
  ],
});
