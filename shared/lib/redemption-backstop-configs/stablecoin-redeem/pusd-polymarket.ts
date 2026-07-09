import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const PUSD_POLYMARKET_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata" },
  reviewedAt: "2026-07-09",
  outputAssetType: "stable-basket",
  costModel: fixedFee(
    0,
    "1:1 wrap/unwrap via CollateralOnramp/Offramp; Polymarket documents no unwrap fee",
  ),
  docs: [
    sourceRef("Polymarket pUSD docs", "https://docs.polymarket.com/concepts/pusd", ["route", "capacity", "fees"]),
    sourceRef("Polymarket withdrawal help", "https://help.polymarket.com/en/articles/13369898-how-to-withdraw", [
      "route",
      "settlement",
    ]),
  ],
  notes: [
    "wrap()/unwrap() burn and mint pUSD 1:1 against a dedicated Polygon vault holding native USDC and bridged USDC.e; fresh reserve telemetry reads that vault's live USDC balance as current direct redemption capacity",
    "The backing vault is a smart account (arbitrary execution) owned by a 12h-timelock-gated 3/6 Safe, and the pUSD token itself is UUPS-upgradeable behind the same timelock, so admin/upgrade risk is not captured by the live vault-balance ratio alone",
  ],
});
