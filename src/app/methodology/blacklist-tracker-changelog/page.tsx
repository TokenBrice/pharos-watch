import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("blacklist-tracker");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Blacklist Tracker Changelog: Version History",
  metadataDescription:
    `Full version history of the Pharos Blacklist Tracker methodology, from v1.0 through ${changelog.currentLabel}. Every event-coverage, cursor, and enrichment revision documented.`,
  breadcrumbName: "Blacklist Tracker Changelog",
  title: "Blacklist Tracker Changelog",
  leadSubject: "Blacklist Tracker",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
