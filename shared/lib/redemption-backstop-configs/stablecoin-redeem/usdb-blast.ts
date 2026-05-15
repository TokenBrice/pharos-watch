import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_FOLLOWUP_REMEDIATION_AT } from "./shared";

export const USDB_BLAST_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_FOLLOWUP_REMEDIATION_AT),
  settlementModel: "days",
  outputAssetType: "stable-single",
  costModel: documentedVariableFee(
    "Blast docs describe USDB redemption for DAI when bridging back to Ethereum; bridge gas and withdrawal costs are variable and no separate fixed redemption fee was identified",
  ),
  routeExitCorrelation: "wrapper-to-parent-dependency",
  docs: [
    sourceRef("Blast developer docs", "https://docs.blast.io/", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
  ],
  notes: [
    "Models the canonical Blast bridge exit from USDB to Ethereum DAI, not secondary-market USDB liquidity on Blast.",
    "Existing live reserve telemetry tracks the Blast USDB yield manager, but this static route only claims documented eventual bridge redeemability.",
  ],
};
