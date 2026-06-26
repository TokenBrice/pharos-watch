import { documentedBoundSupplyFull, fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const YVUSDC_YEARN_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(
    0,
    "Yearn v3 vault withdrawals redeem yvUSDC-1 to USDC at the live vault exchange rate; Yearn reports performance fees on yield, not a separate withdrawal fee.",
  ),
  docs: [
    sourceRef("Yearn v3 USDC vault", "https://yearn.fi/v3/1/0xbe53a109b494e5c9f97b9cd39fe969be68bf6204", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef("Yearn docs", "https://docs.yearn.fi/", ["route", "capacity", "fees", "access", "settlement"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry measures Yearn V3 default-queue withdrawable capacity from total idle USDC plus each funded strategy's maxRedeem(vault) value; if the live snapshot is unavailable, the route is left unrated instead of falling back to full NAV.",
  ],
});
