import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/blacklist-tracker";
import { CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/chain-health";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-dews";
import { DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";
import { LIQUIDITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/liquidity-score";
import { MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/mint-authority";
import { MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/mint-burn-flow";
import { PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/pricing-pipeline";
import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/redemption-backstop";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/safety-score";
import { PSI_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/stability-index";
import { YIELD_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/yield-methodology";

export interface MethodologyManifestEntry {
  readonly key: string;
  readonly doc: string;
  readonly changelogDirectory: string;
  readonly versionFile: string;
  readonly expectedLabel: string;
}

export const METHODOLOGY_MANIFEST: readonly MethodologyManifestEntry[] = [
  {
    key: "pricing-pipeline",
    doc: "docs/pricing-pipeline.md",
    changelogDirectory: "shared/data/methodology-changelogs/pricing-pipeline",
    versionFile: "shared/lib/methodology-versions/pricing-pipeline.ts",
    expectedLabel: PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "stability-index",
    doc: "docs/stability-index.md",
    changelogDirectory: "shared/data/methodology-changelogs/stability-index",
    versionFile: "shared/lib/methodology-versions/stability-index.ts",
    expectedLabel: PSI_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "redemption-backstop",
    doc: "docs/redemption-backstops.md",
    changelogDirectory: "shared/data/methodology-changelogs/redemption-backstop",
    versionFile: "shared/lib/methodology-versions/redemption-backstop.ts",
    expectedLabel: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "mint-burn-flow",
    doc: "docs/mint-burn-flows.md",
    changelogDirectory: "shared/data/methodology-changelogs/mint-burn-flow",
    versionFile: "shared/lib/methodology-versions/mint-burn-flow.ts",
    expectedLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "mint-authority",
    doc: "docs/mint-authority-scoring.md",
    changelogDirectory: "shared/data/methodology-changelogs/mint-authority",
    versionFile: "shared/lib/methodology-versions/mint-authority.ts",
    expectedLabel: MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "depeg-dews",
    doc: "docs/dews.md",
    changelogDirectory: "shared/data/methodology-changelogs/depeg-dews",
    versionFile: "shared/lib/methodology-versions/depeg-dews.ts",
    expectedLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "depeg-detection",
    doc: "docs/depeg-detection.md",
    changelogDirectory: "shared/data/methodology-changelogs/depeg-dews",
    versionFile: "shared/lib/methodology-versions/depeg-dews.ts",
    expectedLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "depeg-resolver",
    doc: "docs/depeg-resolver.md",
    changelogDirectory: "shared/data/methodology-changelogs/depeg-resolver",
    versionFile: "shared/lib/methodology-versions/depeg-resolver.ts",
    expectedLabel: DDR_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "yield-methodology",
    doc: "docs/yield-intelligence.md",
    changelogDirectory: "shared/data/methodology-changelogs/yield-methodology",
    versionFile: "shared/lib/methodology-versions/yield-methodology.ts",
    expectedLabel: YIELD_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "safety-score",
    doc: "docs/report-cards.md",
    changelogDirectory: "shared/data/methodology-changelogs/safety-score",
    versionFile: "shared/lib/methodology-versions/safety-score.ts",
    expectedLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "blacklist-tracker",
    doc: "docs/blacklist-tracker.md",
    changelogDirectory: "shared/data/methodology-changelogs/blacklist-tracker",
    versionFile: "shared/lib/methodology-versions/blacklist-tracker.ts",
    expectedLabel: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "chain-health",
    doc: "docs/chain-health.md",
    changelogDirectory: "shared/data/methodology-changelogs/chain-health",
    versionFile: "shared/lib/methodology-versions/chain-health.ts",
    expectedLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
  },
  {
    key: "liquidity-score",
    doc: "docs/dex-liquidity.md",
    changelogDirectory: "shared/data/methodology-changelogs/liquidity-score",
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

function changelogFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => join(directory, file));
}

export const METHODOLOGY_PROVENANCE_FILES: readonly string[] = [
  ...METHODOLOGY_MANIFEST.flatMap((entry) => [
    entry.versionFile,
    ...changelogFiles(entry.changelogDirectory),
  ]),
  ...METHODOLOGY_INFRA_PROVENANCE_FILES,
];

export { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL, SAFETY_SCORE_METHODOLOGY_VERSION_LABEL };
