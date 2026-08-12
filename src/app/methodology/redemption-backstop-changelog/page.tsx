import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const changelog = getMethodologyChangelogEntry("redemption-backstop");

const route = createStandardMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Redemption Backstop Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Redemption Backstop route methodology, from v1.0 through ${changelog.currentLabel}.`,
  breadcrumbName: "Redemption Backstop Changelog",
  title: "Redemption Backstop Changelog",
  leadSubject: "Redemption Backstop",
  versionLabel: changelog.currentLabel,
  entries: changelog.entries,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
