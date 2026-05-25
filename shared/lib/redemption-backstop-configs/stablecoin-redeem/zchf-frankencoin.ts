import {
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_ZCHF_BRIDGE_AT } from "./shared";

export const ZCHF_FRANKENCOIN_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.0085 },
  costModel: fixedFee(
    0,
    "Reviewed StablecoinBridge source burns ZCHF and transfers the equivalent CHFAU amount with no fee logic",
  ),
  reviewedAt: REVIEWED_ZCHF_BRIDGE_AT,
  docs: [
    sourceRef(
      "Frankencoin StablecoinBridge (CHFAU)",
      "https://etherscan.io/address/0x3e445ff4dddf0ff8ae7458c9746ed80bd664f6c1",
      ["route", "capacity", "fees"],
    ),
    sourceRef(
      "Frankencoin overview",
      "https://docs.frankencoin.com/",
      ["route"],
    ),
    sourceRef(
      "AllUnity CHFAU",
      "https://allunity.com/chfau/",
      ["capacity"],
    ),
  ],
  notes: [
    "Fresh live reserve metadata uses the bridge's current CHFAU balance as the immediate redeemable lower bound for permissionless ZCHF -> CHFAU exits",
    "Frankencoin's price API does not yet publish CHFAU, so reserve telemetry values CHFAU at the existing VCHF CHF-price proxy",
    "Fallback retains a conservative 0.85% bridge-buffer ratio derived from the reviewed CHFAU bridge inventory relative to ZCHF supply on May 25, 2026",
  ],
};
