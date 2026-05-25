import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/chain-health-version";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createStandardMethodologyChangelogRoute({
  path: "/methodology/chain-health-changelog/",
  metadataTitle: "Chain Health Score Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos Chain Health Score methodology, from v1.0 through ${CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL}. Every weight, factor, and tier revision documented.`,
  breadcrumbName: "Chain Health Changelog",
  title: "Chain Health Score Changelog",
  leadSubject: "Chain Health Score",
  versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
  entries: CHAIN_HEALTH_METHODOLOGY_CHANGELOG,
  citation: { id: "chain-health", versionLabel: CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL },
});

export const metadata = route.metadata;
export default route.Page;
