import type { BlacklistStatus } from "@shared/lib/report-cards";

export type CoverageFeatureKey =
  | "price"
  | "safety"
  | "dex"
  | "reserves"
  | "redemption"
  | "yield"
  | "flows"
  | "blacklist"
  | "dependency";

export type CoverageTone = "emerald" | "sky" | "amber" | "violet" | "rose" | "slate";

export interface CoverageStatus {
  kind: string;
  label: string;
  spokenLabel: string;
  tone: CoverageTone;
  available: boolean;
  sortRank: number;
  detail: string;
  sourceCount?: number;
  sourceNames?: string[];
  priceConfidence?: string;
}

export interface CoverageFeatureDefinition {
  key: CoverageFeatureKey;
  label: string;
  shortLabel: string;
  description: string;
  scopeFilter?: (row: CoverageRow) => boolean;
  headlineKinds?: readonly string[];
  headlineFilter?: (row: CoverageRow) => boolean;
  headlineCountLabel?: string;
  headlineCoverageLabel?: (coveragePct: number) => string;
  headlineShareLabel?: string;
  href?: string;
  external?: boolean;
}

export interface CoverageFeatureSummary {
  feature: CoverageFeatureDefinition;
  availableCount: number;
  totalCount: number;
  coveragePct: number;
  coveredMcapUsd: number;
  mcapSharePct: number | null;
  countLabel: string;
  coverageLabel: string;
  shareLabel: string;
  breakdown: string;
}

export interface CoverageRow {
  id: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  pegLabel: string;
  backingLabel: string;
  governanceLabel: string;
  blacklistStatus: BlacklistStatus | null;
  coverageCount: number;
  headlineCoverageCount: number;
  advancedCoverageCount: number;
  statuses: Record<CoverageFeatureKey, CoverageStatus>;
}
