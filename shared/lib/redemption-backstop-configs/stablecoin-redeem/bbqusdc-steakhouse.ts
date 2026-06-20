import { fixedFee, sourceRef } from "../shared";
import {
  defineStablecoinRedeemConfig,
  REVIEWED_YIELD_EXPANSION_AT,
} from "./shared";

export const BBQUSDC_STEAKHOUSE_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(
    0,
    "Smokehouse USDC uses a MetaMorpho vault; withdrawals redeem to USDC when vault liquidity is available and Morpho vault fees accrue from generated yield rather than a separate withdrawal fee.",
  ),
  reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
  docs: [
    sourceRef("Smokehouse USDC vault", "https://app.morpho.org/ethereum/vault/0xbeefff209270748ddd194831b3fa287a5386f5bc/smokehouse-usdc", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef("Smokehouse launch forum", "https://forum.morpho.org/t/introducing-the-smokehouse-product-line-bbqusdc-and-bbqdai/1182", [
      "route",
      "capacity",
      "access",
    ]),
    sourceRef("Morpho vault integration", "https://legacy.docs.morpho.org/morpho-vaults/tutorials/integrate-vaults/", ["route"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as current direct redemption capacity; the prior reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
  ],
});
