import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("stability-index");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Stability Index Changelog: Version History",
  metadataDescription:
    `Full version history of the Pharos Stability Index methodology, from v1.0 through ${changelog.currentLabel}. Every formula, cap, and component revision documented.`,
  breadcrumbName: "Stability Index Changelog",
  title: "Stability Index Changelog",
  leadSubject: "PSI",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
