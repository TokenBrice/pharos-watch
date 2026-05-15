import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const FTUSD_FLYING_TULIP_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic", basis: "strategy-buffer" },
  costModel: documentedVariableFee(
    "Flying Tulip's MintAndRedeem contract supports permissionless 1:1 mint and redemption against USDC or USDT; public docs reviewed do not publish a fixed redemption fee",
  ),
  reviewedAt: "2026-04-16",
  docs: [
    sourceRef("Flying Tulip documentation", "https://docs.flyingtulip.com/", ["route", "capacity"]),
  ],
  notes: [
    "ftUSD uses delta-neutral stablecoin lending + short perpetual hedging",
    "The 10% ratio is a reviewed heuristic reflecting typical delta-neutral protocol on-hand stable buffers rather than a published instant-liquidity floor for this specific protocol",
  ],
};
