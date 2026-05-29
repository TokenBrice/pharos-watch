import {
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const YUSD_YIELDFI_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound", basis: "strategy-buffer" },
  reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
  settlementModel: "queued",
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "YieldFi docs describe yToken redemption requests processed after a cooldown by keeper automation; public docs reviewed do not publish one fixed redemption fee",
  ),
  docs: [
    sourceRef("YieldFi yUSD", "https://docs.yield.fi/technical-docs/ytokens/yusd", ["route", "capacity"]),
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
  ],
};
