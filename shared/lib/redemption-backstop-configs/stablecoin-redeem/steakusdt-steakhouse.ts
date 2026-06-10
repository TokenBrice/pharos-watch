import { documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const STEAKUSDT_STEAKHOUSE_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("ERC-4626/Morpho vault withdrawals redeem to USDT when vault liquidity is available"),
  reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
  docs: [
    sourceRef("Steakhouse Prime Instant", "https://www.steakhouse.financial/docs/products/vault-products/current/prime-instant", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Morpho vault integration", "https://legacy.docs.morpho.org/morpho-vaults/tutorials/integrate-vaults/", ["route"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDT balance as current direct redemption capacity; the prior reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
  ],
});
