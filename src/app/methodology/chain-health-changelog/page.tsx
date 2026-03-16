import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/chain-health-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createMethodologyChangelogRoute({
  path: "/methodology/chain-health-changelog/",
  metadataTitle: "Chain Health Score Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos Chain Health Score methodology, from v1.0 through ${CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL}. Every weight, factor, and tier revision documented.`,
  breadcrumbName: "Chain Health Changelog",
  title: "Chain Health Score Changelog",
  lead: (
    <>
      Full version history of Chain Health Score methodology decisions, from v1.0 to {CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-teal-500",
  entries: CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  selectImpact: (entry) => entry.impact,
});

export const metadata = route.metadata;
export default route.Page;
