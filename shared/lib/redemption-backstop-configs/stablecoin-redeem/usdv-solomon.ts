import { documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_FOLLOWUP_REMEDIATION_AT } from "./shared";

export const USDV_SOLOMON_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  accessModel: "whitelisted-onchain",
  capacityModel: { kind: "supply-ratio", ratio: 0.005, confidence: "documented-bound", basis: "hot-buffer" },
  costModel: documentedVariableFee(
    "Solomon docs disclose a 0.2% mint fee; redemption fee is not separately published, and access is limited to approved or whitelisted participants",
  ),
  reviewedAt: REVIEWED_FOLLOWUP_REMEDIATION_AT,
  docs: [
    sourceRef("Solomon minting USDv", "https://docs.solomonlabs.org/usdv/usdv-and-susdv/minting-usdv", [
      "route",
      "access",
      "fees",
    ]),
    sourceRef(
      "Solomon peg arbitrage",
      "https://docs.solomonlabs.org/usdv/usdv-and-susdv/peg-arbitrage-mechanism",
      ["route", "capacity", "access", "settlement"],
    ),
  ],
  notes: [
    "Modeled as the whitelisted USDv to USDC redemption path via Solomon protocol reserves, not as full strategy-collateral redeemability.",
    "The documented 0.5% reserve buffer is the immediate capacity bound; strategy assets and derivatives backing remain outside immediate redemption capacity.",
  ],
});
