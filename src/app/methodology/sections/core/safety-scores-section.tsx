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
      versionBadge={{ label: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL }}
      changelogPath={SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when weights, thresholds, or dimension definitions change."
      changelogClassName="hover:text-amber-700 dark:hover:text-amber-400"
    >
      <SafetyScoresOverview />
      <SafetyScoresTechnicalDetails />
    </MethodologySectionShell>
  );
}
