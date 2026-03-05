import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-dews-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createMethodologyChangelogRoute({
  path: "/methodology/depeg-changelog/",
  metadataTitle: "Depeg Tracker + DEWS Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Depeg Tracker + DEWS methodology, from v1.0 through ${DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}. Every threshold, formula, and confirmation-policy revision documented.`,
  breadcrumbName: "Depeg Tracker + DEWS Changelog",
  title: "Depeg Tracker + DEWS Changelog",
  lead: (
    <>
      Full version history of Depeg Tracker and DEWS methodology decisions, from v1.0 to {DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-amber-500",
  entries: DEPEG_DEWS_METHODOLOGY_CHANGELOG,
  selectImpact: (entry) => entry.methodologyImpact,
});

export const metadata = route.metadata;
export default route.Page;
