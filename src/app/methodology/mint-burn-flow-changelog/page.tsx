import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("mint-burn-flow");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Mint/Burn Flow Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${changelog.currentLabel}. Every scoring and ingestion-policy revision documented.`,
  breadcrumbName: "Mint/Burn Flow Changelog",
  title: "Mint/Burn Flow Changelog",
  leadSubject: "Mint/Burn Flow",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
