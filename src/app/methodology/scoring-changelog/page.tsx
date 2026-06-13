import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
} from "@shared/lib/safety-score-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";
import { ScoringChangelogContent, scoringAnchorId } from "./content";

const PAGE_PATH = SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH;

const route = createMethodologyChangelogRoute({
  path: PAGE_PATH,
  metadataTitle: "Safety Scores Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos safety scoring methodology, from v1.0 through ${SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}. Every weight change, new dimension, and structural decision documented.`,
  breadcrumbName: "Scoring Changelog",
  title: "Safety Scores Changelog",
  lead: (
    <>
      Full version history of the grading methodology &mdash; every weight
      change, new dimension, and structural decision from v1.0 to {SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}.
    </>
  ),
  entries: SAFETY_SCORE_METHODOLOGY_CHANGELOG,
  sections: SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS.map((version) => ({
    id: scoringAnchorId(version),
    label: version,
  })),
  renderContent: () => <ScoringChangelogContent />,
  citation: { id: "safety-score", versionLabel: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL },
});

export const metadata = route.metadata;
export default route.Page;
