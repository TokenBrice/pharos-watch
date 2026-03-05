import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createMethodologyChangelogRoute({
  path: "/methodology/yield-changelog/",
  metadataTitle: "Yield Intelligence Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Yield Intelligence methodology, from v1.0 through ${YIELD_METHODOLOGY_VERSION_LABEL}. Every source-resolution and scoring revision documented.`,
  breadcrumbName: "Yield Intelligence Changelog",
  title: "Yield Intelligence Changelog",
  lead: (
    <>
      Full version history of Yield Intelligence methodology decisions, from v1.0 to {YIELD_METHODOLOGY_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-violet-500",
  entries: YIELD_METHODOLOGY_CHANGELOG,
  selectImpact: (entry) => entry.methodologyImpact,
});

export const metadata = route.metadata;
export default route.Page;
