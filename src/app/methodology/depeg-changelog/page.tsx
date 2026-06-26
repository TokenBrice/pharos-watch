import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("depeg-dews");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Depeg Tracker + DEWS Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Depeg Tracker + DEWS methodology, from v1.0 through ${changelog.currentLabel}. Every threshold, formula, and confirmation-policy revision documented.`,
  breadcrumbName: "Depeg Tracker + DEWS Changelog",
  title: "Depeg Tracker + DEWS Changelog",
  leadSubject: "Depeg Tracker and DEWS",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
