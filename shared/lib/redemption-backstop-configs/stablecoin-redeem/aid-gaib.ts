import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, reviewedDirectRedemptionSupplyFull } from "./shared";

export const AID_GAIB_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...reviewedDirectRedemptionSupplyFull,
  accessModel: "whitelisted-onchain",
  costModel: fixedFee(
    10,
    "GAIB docs currently show a 10 bps sell fee in the dApp, while direct AID minting and redemption are reserved for whitelisted users and partners",
  ),
  docs: [
    sourceRef(
      "GAIB AI Dollar (AID)",
      "https://docs.gaib.ai/products/gaib-products/ai-dollar-aid",
      ["route", "capacity", "access", "fees"],
    ),
    sourceRef(
      "GAIB economy",
      "https://docs.gaib.ai/gaib-overview/gaib-economy",
      ["route", "capacity"],
    ),
  ],
  notes: [
    "Regular users typically exit AID through the GAIB app or DEX liquidity, while the modeled primary redemption rail is the whitelisted direct burn-and-withdraw contract path",
  ],
});
