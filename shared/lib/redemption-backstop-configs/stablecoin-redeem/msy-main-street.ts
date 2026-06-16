import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const MSY_MAIN_STREET_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  totalScoreCap: 65,
  costModel: fixedFee(
    0,
    "Main Street msY ERC-4626 (0x890a5122aa1da30fec4286de7904ff808f0bd74a): on-chain previewRedeem == convertToAssets with no fee delta; T&C charge fees only on msUSD mint, not the msY unwrap step",
  ),
  docs: [
    sourceRef("Main Street staking model", "https://mainstreet-finance.gitbook.io/mainstreet.finance/staking-model", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Main Street msY vault", "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/strategy-vaults/msy-the-options-box-spread", ["route", "capacity"]),
    sourceRef("Main Street redemption process", "https://mainstreet-finance.gitbook.io/mainstreet.finance/msusd-and-strategy-vaults/redemption-process", ["route", "capacity", "settlement"]),
  ],
  notes: [
    "msY exits to msUSD at the live staking exchange rate; final USDC redemption inherits Main Street's primary-market capacity limits and cooldown.",
    "Config-level cap reflects that the wrapper exit alone does not return holders to USDC, and downstream msUSD redemption can be capped or delayed during strategy unwinds.",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle msUSD balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
