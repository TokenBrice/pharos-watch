import {
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { scoringAnchorId } from "./content-shared";
import { ScoringChangelogV8Entries } from "./content-v8";
import { ScoringChangelogV7Entries } from "./content-v7";
import { ScoringChangelogV6Entries } from "./content-v6";
import { ScoringChangelogV5Entries } from "./content-v5";
import { ScoringChangelogLegacyEntries } from "./content-legacy";
import { ScoringChangelogSummaryTables } from "./content-summary";

export { scoringAnchorId };

export function ScoringChangelogContent() {
  return (
    <>
      <ScoringChangelogV8Entries />
      <ScoringChangelogV7Entries />
      <ScoringChangelogV6Entries />
      <ScoringChangelogV5Entries />
      <ScoringChangelogLegacyEntries />
      <ScoringChangelogSummaryTables />
    </>
  );
}

export { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL };
