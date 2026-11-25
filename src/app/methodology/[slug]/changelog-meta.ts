import type { MethodologyChangelogRegistryKey } from "@shared/lib/methodology-versions/registry";
import { METHODOLOGY_HISTORY_ARCHIVES } from "@shared/lib/methodology-versions/archives";
import type { MethodologySiblingArchive } from "@/components/methodology-history/methodology-changelog-page";

export interface MethodologyChangelogRouteMeta {
  methodologyAnchor: string;
  docsPath?: string;
}

export const CHANGELOG_ROUTE_META: Record<MethodologyChangelogRegistryKey, MethodologyChangelogRouteMeta> = {
  "safety-score": {
    methodologyAnchor: "safety-scores-methodology",
    docsPath: "/docs/report-cards/",
  },
  "depeg-dews": {
    methodologyAnchor: "pegscore-dews-methodology",
    docsPath: "/docs/depeg-detection/",
  },
  "depeg-resolver": {
    methodologyAnchor: "depeg-resolver-methodology",
    docsPath: "/docs/depeg-detection/",
  },
  "liquidity-score": {
    methodologyAnchor: "liquidity-methodology",
    docsPath: "/docs/dex-liquidity/",
  },
  "redemption-backstop": {
    methodologyAnchor: "redemption-backstop-methodology",
    docsPath: "/docs/redemption-backstops/",
  },
  "stability-index": {
    methodologyAnchor: "stability-index-methodology",
    docsPath: "/docs/stability-index/",
  },
  "chain-health": {
    methodologyAnchor: "chain-health-score",
    docsPath: "/docs/chain-health/",
  },
  yield: {
    methodologyAnchor: "yield-intelligence-methodology",
    docsPath: "/docs/yield-intelligence/",
  },
  "blacklist-tracker": {
    methodologyAnchor: "blacklist-tracker-methodology",
    docsPath: "/docs/blacklist-tracker/",
  },
  "mint-burn-flow": {
    methodologyAnchor: "mint-burn-flow-methodology",
    docsPath: "/docs/mint-burn-flows/",
  },
  "pricing-pipeline": {
    methodologyAnchor: "pricing-pipeline-methodology",
    docsPath: "/docs/pricing-pipeline/",
  },
};

export function getSiblingArchives(slug: string, activeArchive?: string): MethodologySiblingArchive[] {
  return METHODOLOGY_HISTORY_ARCHIVES.filter((entry) => entry.slug === slug).map((entry) => ({
    archive: entry.archive,
    href: entry.path,
    current: entry.archive === activeArchive,
  }));
}
