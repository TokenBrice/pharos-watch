import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { MethodologySectionShell } from "../../methodology-shared";
import { SAFETY_SCORES_SECTION_CONTENT } from "../methodology-content";
import { SafetyScoresOverview } from "./safety-scores-overview";
import { SafetyScoresTechnicalDetails } from "./safety-scores-technical-details";

export function SafetyScoresMethodologySection() {
  return (
    <MethodologySectionShell
      id={SAFETY_SCORES_SECTION_CONTENT.id}
      title={SAFETY_SCORES_SECTION_CONTENT.title}
      versionBadge={{ label: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL.toUpperCase() }}
      changelogPath={SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH}
      versionNote="V9 is the sole active publication and consumer contract. V8.17 remains available only in version history."
      changelogClassName="hover:text-amber-700 dark:hover:text-amber-400"
    >
      <SafetyScoresOverview />
      <SafetyScoresTechnicalDetails />
    </MethodologySectionShell>
  );
}
