import {
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createMethodologyChangelogRoute({
  path: "/methodology/liquidity-score-changelog/",
  metadataTitle: "Liquidity Score Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Liquidity Score methodology, from v1.0 through ${LIQUIDITY_METHODOLOGY_VERSION_LABEL}. Every scoring and normalization revision documented.`,
  breadcrumbName: "Liquidity Score Changelog",
  title: "Liquidity Score Changelog",
  lead: (
    <>
      Full version history of Liquidity Score methodology decisions, from v1.0 to {LIQUIDITY_METHODOLOGY_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-cyan-500",
  entries: LIQUIDITY_METHODOLOGY_CHANGELOG,
  selectImpact: (entry) => entry.impact,
});

export const metadata = route.metadata;
export default route.Page;
