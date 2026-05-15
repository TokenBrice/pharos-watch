import {
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_ZCHF_BRIDGE_AT } from "./shared";

export const ZCHF_FRANKENCOIN_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.014 },
  costModel: fixedFee(
    0,
    "Reviewed StablecoinBridge source burns ZCHF and transfers the same amount of VCHF with no fee logic",
  ),
  reviewedAt: REVIEWED_ZCHF_BRIDGE_AT,
  docs: [
    sourceRef(
      "Frankencoin StablecoinBridge (VCHF)",
      "https://etherscan.io/address/0x3b71ba73299f925a837836160c3e1fec74340403",
      ["route", "capacity", "fees"],
    ),
    sourceRef(
      "Frankencoin overview",
      "https://docs.frankencoin.com/",
      ["route"],
    ),
    sourceRef(
      "VNX docs",
      "https://vnx.gitbook.io/vnx-platform/",
      ["capacity"],
    ),
  ],
  notes: [
    "Fresh live reserve metadata uses the bridge's current VCHF balance as the immediate redeemable lower bound for permissionless ZCHF -> VCHF exits",
    "Fallback retains a conservative 1.4% bridge-buffer ratio derived from the reviewed bridge inventory relative to ZCHF supply on April 6, 2026",
  ],
};
