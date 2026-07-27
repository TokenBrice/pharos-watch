import { SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH } from "@shared/lib/methodology-versions/constants";
import { MethodologySectionShell } from "../../methodology-shared";
import { SAFETY_SCORES_SECTION_CONTENT } from "../methodology-content";
import { SafetyScoresOverview } from "./safety-scores-overview";
import { SafetyScoresTechnicalDetails } from "./safety-scores-technical-details";

export function SafetyScoresMethodologySection() {
  return (
    <MethodologySectionShell
      id={SAFETY_SCORES_SECTION_CONTENT.id}
      title={SAFETY_SCORES_SECTION_CONTENT.title}
      versionBadge={{ label: "V9 · candidate-v2" }}
      changelogPath={SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Active V9 policy identity; the compatibility endpoint retains the numeric V8.17 methodology."
      changelogClassName="hover:text-amber-700 dark:hover:text-amber-400"
    >
      <SafetyScoresOverview />
      <SafetyScoresTechnicalDetails />
    </MethodologySectionShell>
  );
}
