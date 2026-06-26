import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("liquidity-score");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Liquidity Score Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Liquidity Score methodology, from v1.0 through ${changelog.currentLabel}. Every scoring and normalization revision documented.`,
  breadcrumbName: "Liquidity Score Changelog",
  title: "Liquidity Score Changelog",
  leadSubject: "Liquidity Score",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
