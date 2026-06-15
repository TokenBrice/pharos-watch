import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const USDSC_STARTALE_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata" },
  reviewedAt: "2026-04-16",
  accessModel: "whitelisted-onchain",
  holderEligibility: "whitelisted-primary",
  totalScoreCap: 70,
  costModel: fixedFee(0, "Startale docs describe USDSC as a fee-free 1:1 wrapper around M0's M token on Soneium"),
  docs: [
    sourceRef("Startale USDSC", "https://startale.com/usdsc", ["route", "capacity", "fees"]),
    sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
  ],
  notes: [
    "1:1 wrapper around M: mint by wrapping, redeem through Startale's M0 SwapFacility extension; underlying M is backed by T-bill collateral attested by M0 Validators",
    "Fresh live reserve metadata reads the current M balance held by the USDSC extension and verifies the configured SwapFacility path is enabled for the approved swapper.",
    "Config-level cap reflects that the USDSC->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail still gates actual par exit",
  ],
});
