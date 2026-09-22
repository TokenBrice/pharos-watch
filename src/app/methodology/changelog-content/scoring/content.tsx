import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/registry";
import { scoringAnchorId, StructuredChangelogDetail, VersionCard } from "./content-shared";
import { ScoringChangelogSummaryTables } from "./content-summary";

export { scoringAnchorId };

/**
 * Every version renders from its structured changelog record, so shipping a new
 * version only requires the entry in
 * `shared/data/methodology-changelogs/safety-score/` — no JSX block here.
 */
export function ScoringChangelogContent() {
  return (
    <>
      {SAFETY_SCORE_METHODOLOGY_CHANGELOG.map((entry) => (
        <VersionCard key={entry.version} entry={entry}>
          <StructuredChangelogDetail entry={entry} />
        </VersionCard>
      ))}
      <ScoringChangelogSummaryTables />
    </>
  );
}
