import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const USDZ_ANZEN_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull("2026-04-16"),
  accessModel: "whitelisted-onchain",
  costModel: undisclosedReviewedFee(
    "Qualified Market Makers mint and redeem 1:1 USDz/USDC against SPCT collateral; public docs reviewed do not publish a fixed retail redemption fee",
  ),
  docs: [
    sourceRef("Anzen Finance", "https://www.anzen.finance/", ["route"]),
    sourceRef("Anzen documentation", "https://docs.anzen.finance/", ["route", "capacity"]),
  ],
  notes: [
    "Primary mint and redeem rail is reserved for whitelisted Qualified Market Makers; retail holders exit via DEX liquidity while arbitrage by QMMs maintains the peg against SPCT collateral",
  ],
};
