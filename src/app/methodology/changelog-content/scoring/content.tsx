import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/registry";
import type { MethodologyChangelogEntry } from "@shared/types/editorial-content";
import { scoringAnchorId, StructuredChangelogDetail, VersionCard } from "@/components/methodology-changelog-detail";
import { ScoringChangelogSummaryTables } from "./content-summary";

export { scoringAnchorId };

/**
 * Every version renders from its structured changelog record, so shipping a new
 * version only requires the entry in
 * `shared/data/methodology-changelogs/safety-score/` — no JSX block here.
 */
export function ScoringChangelogContent({
  entries = SAFETY_SCORE_METHODOLOGY_CHANGELOG,
}: { entries?: readonly MethodologyChangelogEntry[] }) {
  return (
    <>
      {entries.map((entry) => (
        <VersionCard key={entry.version} entry={entry}>
          <StructuredChangelogDetail entry={entry} />
        </VersionCard>
      ))}
      {entries.some((entry) => entry.version.startsWith("8.")) && <ScoringChangelogSummaryTables />}
    </>
  );
}
