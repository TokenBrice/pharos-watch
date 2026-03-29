import {
  SAFETY_SCORE_VERSION_LABEL,
} from "@shared/lib/safety-score-version";
import { scoringAnchorId } from "./content-shared";
import { ScoringChangelogV6Entries } from "./content-v6";
import { ScoringChangelogV5Entries } from "./content-v5";
import { ScoringChangelogLegacyEntries } from "./content-legacy";
import { ScoringChangelogSummaryTables } from "./content-summary";

export { scoringAnchorId };

export function ScoringChangelogContent() {
  return (
    <>
      <ScoringChangelogV6Entries />
      <ScoringChangelogV5Entries />
      <ScoringChangelogLegacyEntries />
      <ScoringChangelogSummaryTables />
    </>
  );
}

export { SAFETY_SCORE_VERSION_LABEL };
