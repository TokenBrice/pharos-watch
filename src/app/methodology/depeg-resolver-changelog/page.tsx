import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("depeg-resolver");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Depeg Duration Resolver Changelog: Version History",
  metadataDescription:
    `Full version history of the Pharos Depeg Duration Resolver methodology, from v1.0 through ${changelog.currentLabel}. Every resolution-rubric, stratification, and support-gate revision documented.`,
  breadcrumbName: "Depeg Duration Resolver Changelog",
  title: "Depeg Duration Resolver Changelog",
  leadSubject: "DDR",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
