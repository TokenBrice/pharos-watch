import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const STEAKUSDT_STEAKHOUSE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "heuristic", basis: "strategy-buffer" },
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("ERC-4626/Morpho vault withdrawals redeem to USDT when vault liquidity is available"),
  reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
  docs: [
    sourceRef("Steakhouse Prime Instant", "https://www.steakhouse.financial/docs/products/vault-products/current/prime-instant", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Morpho vault integration", "https://legacy.docs.morpho.org/morpho-vaults/tutorials/integrate-vaults/", ["route"]),
  ],
};
