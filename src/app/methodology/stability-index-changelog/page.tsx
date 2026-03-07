import {
  PSI_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/stability-index-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createMethodologyChangelogRoute({
  path: "/methodology/stability-index-changelog/",
  metadataTitle: "Stability Index Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos Stability Index methodology, from v1.0 through ${PSI_METHODOLOGY_VERSION_LABEL}. Every formula, cap, and component revision documented.`,
  breadcrumbName: "Stability Index Changelog",
  title: "Stability Index Changelog",
  lead: (
    <>
      Full version history of PSI methodology decisions, from v1.0 to {PSI_METHODOLOGY_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-cyan-500",
  entries: PSI_METHODOLOGY_CHANGELOG,
  selectImpact: (entry) => entry.impact,
});

export const metadata = route.metadata;
export default route.Page;
