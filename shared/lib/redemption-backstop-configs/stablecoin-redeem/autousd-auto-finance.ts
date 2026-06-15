import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const AUTOUSD_AUTO_FINANCE_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(
    0,
    "Auto Finance autopool redeem/withdraw burns autoUSD shares for USDC without a separate exit-fee deduction; streaming and periodic fees are NAV/accounting fees",
  ),
  reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
  docs: [
    sourceRef("Auto Finance autopools overview", "https://docs.auto.finance/auto-pools-protocol/autopools-tl-dr.md", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef("Auto Finance protocol mechanics", "https://docs.auto.finance/auto-pools-protocol/protocol-mechanics.md", [
      "route",
      "capacity",
      "access",
      "settlement",
    ]),
    sourceRef(
      "Auto Finance contract addresses",
      "https://docs.auto.finance/developer-docs/contracts-overview/contract-addresses",
      ["route", "capacity", "access"],
    ),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the autopool's idle USDC balance as current direct redemption capacity; the reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
  ],
});
