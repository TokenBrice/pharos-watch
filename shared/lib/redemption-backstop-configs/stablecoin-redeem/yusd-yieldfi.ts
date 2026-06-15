import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const YUSD_YIELDFI_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1, confidence: "documented-bound", basis: "strategy-buffer" },
  reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
  settlementModel: "queued",
  executionModel: "rules-based-nav",
  costModel: fixedFee(
    0,
    "YieldFi yUSD token terms list no redemption fee other than network gas; requests still settle after the documented cooldown/keeper process.",
  ),
  docs: [
    sourceRef("YieldFi yUSD token terms", "https://docs.yield.fi/legal-documents/token-terms/yusd", [
      "route",
      "capacity",
      "fees",
    ]),
    sourceRef("YieldFi smart contract interaction", "https://docs.yield.fi/technical-docs/smart-contract-interaction", [
      "route",
      "capacity",
      "access",
      "settlement",
    ]),
    sourceRef("YieldFi fees", "https://docs.yield.fi/fees", ["fees"]),
  ],
  notes: [
    "yUSD is an ERC-4626 vault over USDC; redemption burns shares immediately but underlying USDC is delivered through a queued request after the cooldown period.",
    "Because yUSD allocates into delta-neutral and private-credit strategy positions, the reviewed route uses the documented queued route with a conservative 10% strategy-buffer capacity instead of scoring against full supply.",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as the current redeemable bound while the queued request flow still governs settlement; the reviewed 10% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
  ],
});
