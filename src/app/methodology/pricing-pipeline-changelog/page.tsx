import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("pricing-pipeline");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Pricing Pipeline Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Pricing Pipeline methodology, from v1.0 through ${changelog.currentLabel}. Every source addition and consensus algorithm revision documented.`,
  breadcrumbName: "Pricing Pipeline Changelog",
  title: "Pricing Pipeline Changelog",
  leadSubject: "Pricing Pipeline",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
