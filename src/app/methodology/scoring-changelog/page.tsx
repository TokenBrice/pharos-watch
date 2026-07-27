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
    "Safety Score methodology history from V1 through the active V9 candidate-v2 identity, including the retained V8 compatibility methodology.",
  breadcrumbName: "Scoring Changelog",
  title: "Safety Scores Changelog",
  lead: (
    <>
      The active V9 identity and the full numeric V8-and-earlier grading history
      &mdash; every weight change, new pillar or dimension, and structural decision.
    </>
  ),
  entries: changelog.entries,
  sections: [
    { id: scoringAnchorId("V9 · candidate-v2"), label: "V9 · candidate-v2" },
    ...SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS.map((version) => ({
      id: scoringAnchorId(version),
      label: version,
    })),
  ],
  renderContent: () => <ScoringChangelogContent />,
  citation: { id: changelog.citationId, versionLabel: "v9-candidate-v2" },
});

export const metadata = route.metadata;
export default route.Page;
