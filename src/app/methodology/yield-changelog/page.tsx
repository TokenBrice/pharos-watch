import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("yield");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Yield Intelligence Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Yield Intelligence methodology, from v1.0 through ${changelog.currentLabel}. Every source-resolution and scoring revision documented.`,
  breadcrumbName: "Yield Intelligence Changelog",
  title: "Yield Intelligence Changelog",
  leadSubject: "Yield Intelligence",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
