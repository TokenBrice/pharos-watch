import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { MethodologySectionShell } from "../../methodology-shared";
import { SAFETY_SCORES_SECTION_CONTENT } from "@/lib/methodology-content";
import { SafetyScoresOverview } from "./safety-scores-overview";
import { SafetyScoresTechnicalDetails } from "./safety-scores-technical-details";
import { METHODOLOGY_SECTION_ACCENT_CLASSES } from "@shared/lib/classification";

export function SafetyScoresMethodologySection() {
  return (
    <MethodologySectionShell
      id={SAFETY_SCORES_SECTION_CONTENT.id}
      title={SAFETY_SCORES_SECTION_CONTENT.title}
      versionBadge={{ label: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL.toUpperCase() }}
      changelogPath={SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Active Safety Score publication and consumer contract. Retired scoring models remain documented in version history."
      changelogClassName={METHODOLOGY_SECTION_ACCENT_CLASSES.safetyScores.changelogHover}
    >
      <SafetyScoresOverview />
      <SafetyScoresTechnicalDetails />
    </MethodologySectionShell>
  );
}
