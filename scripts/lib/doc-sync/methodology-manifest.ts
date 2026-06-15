import { BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL } from "@shared/lib/blacklist-tracker-version";
import { CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL } from "@shared/lib/chain-health-version";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/liquidity-score-version";
import { MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL } from "@shared/lib/mint-burn-flow-version";
import { PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/pricing-pipeline-version";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL } from "@shared/lib/redemption-backstop-version";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/safety-score-version";
import { PSI_METHODOLOGY_VERSION_LABEL } from "@shared/lib/stability-index-version";
import { YIELD_METHODOLOGY_VERSION_LABEL } from "@shared/lib/yield-methodology-version";

export interface MethodologyManifestEntry {
  readonly key: string;
  readonly doc: string;
  readonly timelineDoc?: string;
  readonly versionFile: string;
  readonly extraProvenanceFiles?: readonly string[];
  readonly expectedLabel: string;
}

export const METHODOLOGY_MANIFEST: readonly MethodologyManifestEntry[] = [
  {
    key: "pricing-pipeline",
    doc: "docs/pricing-pipeline.md",
    timelineDoc: "docs/pricing-pipeline-timeline.md",
    versionFile: "shared/lib/methodology-versions/pricing-pipeline.ts",
    expectedLabel: PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "stability-index",
    doc: "docs/stability-index.md",
    timelineDoc: "docs/stability-index-timeline.md",
    versionFile: "shared/lib/methodology-versions/stability-index.ts",
    extraProvenanceFiles: [
      "shared/data/methodology-changelogs/stability-index/v1.ts",
      "shared/data/methodology-changelogs/stability-index/v2.ts",
      "shared/data/methodology-changelogs/stability-index/v3.ts",
    ],
    expectedLabel: PSI_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "redemption-backstop",
    doc: "docs/redemption-backstops.md",
    versionFile: "shared/lib/methodology-versions/redemption-backstop.ts",
    expectedLabel: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "mint-burn-flow",
    doc: "docs/mint-burn-flows.md",
    timelineDoc: "docs/mint-burn-flows-timeline.md",
    versionFile: "shared/lib/methodology-versions/mint-burn-flow.ts",
    expectedLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "depeg-dews",
    doc: "docs/dews.md",
    timelineDoc: "docs/depeg-dews-timeline.md",
    versionFile: "shared/lib/methodology-versions/depeg-dews.ts",
    expectedLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "yield-methodology",
    doc: "docs/yield-intelligence.md",
    timelineDoc: "docs/yield-intelligence-timeline.md",
    versionFile: "shared/lib/methodology-versions/yield-methodology.ts",
    expectedLabel: YIELD_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "safety-score",
    doc: "docs/report-cards.md",
    timelineDoc: "docs/report-cards-timeline.md",
    versionFile: "shared/lib/methodology-versions/safety-score.ts",
    expectedLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "blacklist-tracker",
    doc: "docs/blacklist-tracker.md",
    timelineDoc: "docs/blacklist-tracker-timeline.md",
    versionFile: "shared/lib/methodology-versions/blacklist-tracker.ts",
    expectedLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "chain-health",
    doc: "docs/chain-health.md",
    timelineDoc: "docs/chain-health-timeline.md",
    versionFile: "shared/lib/methodology-versions/chain-health.ts",
    extraProvenanceFiles: ["shared/data/methodology-changelogs/chain-health/v1.ts"],
    expectedLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "liquidity-score",
    doc: "docs/dex-liquidity.md",
    timelineDoc: "docs/liquidity-score-timeline.md",
    versionFile: "shared/lib/methodology-versions/liquidity-score.ts",
    expectedLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
  },
];

const METHODOLOGY_INFRA_PROVENANCE_FILES = [
  "shared/lib/methodology-versions/base.ts",
] as const;

export const METHODOLOGY_DOC_VERSION_CHECKS = METHODOLOGY_MANIFEST.map((entry) => ({
  file: entry.doc,
  expectedVersionLabel: entry.expectedLabel,
}));

export const METHODOLOGY_PROVENANCE_FILES: readonly string[] = [
  ...METHODOLOGY_MANIFEST.flatMap((entry) => [
    ...(entry.timelineDoc ? [entry.timelineDoc] : []),
    entry.versionFile,
    ...(entry.extraProvenanceFiles ?? []),
  ]),
  ...METHODOLOGY_INFRA_PROVENANCE_FILES,
];

export { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL, SAFETY_SCORE_METHODOLOGY_VERSION_LABEL };
