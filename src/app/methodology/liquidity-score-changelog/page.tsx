import {
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createStandardMethodologyChangelogRoute({
  path: "/methodology/liquidity-score-changelog/",
  metadataTitle: "Liquidity Score Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Liquidity Score methodology, from v1.0 through ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}. Every scoring and normalization revision documented.`,
  breadcrumbName: "Liquidity Score Changelog",
  title: "Liquidity Score Changelog",
  leadSubject: "Liquidity Score",
  versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
  entries: LIQUIDITY_METHODOLOGY_CHANGELOG,
  citation: { id: "liquidity-score", versionLabel: LIQUIDITY_METHODOLOGY_VERSION_LABEL },
});

export const metadata = route.metadata;
export default route.Page;
