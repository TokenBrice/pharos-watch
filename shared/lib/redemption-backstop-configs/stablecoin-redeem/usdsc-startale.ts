import { documentedBoundSupplyFull, fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const USDSC_STARTALE_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull("2026-04-16"),
  totalScoreCap: 70,
  costModel: fixedFee(0, "Startale docs describe USDSC as a fee-free 1:1 wrapper around M0's M token on Soneium"),
  docs: [
    sourceRef("Startale USDSC", "https://startale.com/usdsc", ["route", "capacity", "fees"]),
    sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
  ],
  notes: [
    "1:1 wrapper around M: mint by wrapping, redeem by unwrapping; underlying M is backed by T-bill collateral attested by M0 Validators",
    "Config-level cap reflects that the USDSC->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail still gates actual par exit",
  ],
});
