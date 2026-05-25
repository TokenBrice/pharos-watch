import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createStandardMethodologyChangelogRoute({
  path: "/methodology/yield-changelog/",
  metadataTitle: "Yield Intelligence Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Yield Intelligence methodology, from v1.0 through ${YIELD_METHODOLOGY_VERSION_LABEL}. Every source-resolution and scoring revision documented.`,
  breadcrumbName: "Yield Intelligence Changelog",
  title: "Yield Intelligence Changelog",
  leadSubject: "Yield Intelligence",
  versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
  entries: YIELD_METHODOLOGY_CHANGELOG,
  citation: { id: "yield", versionLabel: YIELD_METHODOLOGY_VERSION_LABEL },
});

export const metadata = route.metadata;
export default route.Page;
