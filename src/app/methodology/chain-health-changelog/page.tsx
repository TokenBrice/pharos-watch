import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("chain-health");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Chain Health Score Changelog: Version History",
  metadataDescription:
    `Full version history of the Pharos Chain Health Score methodology, from v1.0 through ${changelog.currentLabel}. Every weight, factor, and tier revision documented.`,
  breadcrumbName: "Chain Health Changelog",
  title: "Chain Health Score Changelog",
  leadSubject: "Chain Health Score",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
