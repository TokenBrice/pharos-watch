import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS,
} from "@shared/lib/safety-score-version";
import { getMethodologyChangelogEntry } from "@shared/lib/methodology-versions/registry";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";
import { ScoringChangelogContent, scoringAnchorId } from "./content";

const changelog = getMethodologyChangelogEntry("safety-score");

const route = createMethodologyChangelogRoute({
  path: changelog.publicPath,
  metadataTitle: "Safety Scores Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos safety scoring methodology, from v1.0 through ${changelog.currentLabel}. Every weight change, new dimension, and structural decision documented.`,
  breadcrumbName: "Scoring Changelog",
  title: "Safety Scores Changelog",
  lead: (
    <>
      Full version history of the grading methodology &mdash; every weight
      change, new dimension, and structural decision from v1.0 to {changelog.currentLabel}.
    </>
  ),
  entries: changelog.entries,
  sections: SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS.map((version) => ({
    id: scoringAnchorId(version),
    label: version,
  })),
  renderContent: () => <ScoringChangelogContent />,
  citation: { id: changelog.citationId, versionLabel: changelog.currentLabel },
});

export const metadata = route.metadata;
export default route.Page;
