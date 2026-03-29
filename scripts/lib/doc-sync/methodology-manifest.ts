import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/depeg-dews-version";
import { MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL } from "@shared/lib/mint-burn-flow-version";
import { PRICING_PIPELINE_VERSION_LABEL } from "@shared/lib/pricing-pipeline-version";
import { REDEMPTION_BACKSTOP_VERSION_LABEL } from "@shared/lib/redemption-backstop-version";
import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";
import { PSI_METHODOLOGY_VERSION_LABEL } from "@shared/lib/stability-index-version";
import { YIELD_METHODOLOGY_VERSION_LABEL } from "@shared/lib/yield-methodology-version";

export const METHODOLOGY_DOC_VERSION_CHECKS = [
  {
    file: "docs/pricing-pipeline.md",
    expectedVersionLabel: PRICING_PIPELINE_VERSION_LABEL,
  },
  {
    file: "docs/stability-index.md",
    expectedVersionLabel: PSI_METHODOLOGY_VERSION_LABEL,
  },
  {
    file: "docs/redemption-backstops.md",
    expectedVersionLabel: REDEMPTION_BACKSTOP_VERSION_LABEL,
  },
  {
    file: "docs/mint-burn-flows.md",
    expectedVersionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  },
  {
    file: "docs/dews.md",
    expectedVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  },
  {
    file: "docs/yield-intelligence.md",
    expectedVersionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
  },
] as const;

export { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL, SAFETY_SCORE_VERSION_LABEL };
