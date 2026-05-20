import {
  documentedBoundSupplyFull,
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const WM_M0_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull("2026-04-16"),
  totalScoreCap: 70,
  costModel: fixedFee(0, "wM docs describe wrap and unwrap as fee-free permissionless calls against the underlying M token"),
  docs: [
    sourceRef("M0 wM token", "https://www.m0.org/faq", ["route", "capacity", "fees"]),
    sourceRef("M0 Dashboard", "https://dashboard.m0.org/", ["capacity"]),
  ],
  notes: [
    "Permissionless ERC-20 wrapper: wrap() deposits M and mints wM; unwrap() redeems 1:1 back to M with no fee or queue",
    "Config-level cap reflects that the wM->M unwrap does not by itself return the holder to a liquid stablecoin; the downstream M redemption rail (institution-only M0 mint/burn) still gates actual par exit",
  ],
};
