import type { ReactNode } from "react";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/methodology-versions/safety-score";
import { scoringAnchorId, StructuredChangelogDetail, VersionCard } from "./content-shared";
import { scoringChangelogV8Details } from "./content-v8";
import { scoringChangelogV729Details } from "./content-v7-29";
import { scoringChangelogV728Details } from "./content-v7-28";
import { scoringChangelogV727Details } from "./content-v7-27";
import { scoringChangelogV70Details } from "./content-v7-0";
import { scoringChangelogV6Details } from "./content-v6";
import { scoringChangelogV5Details } from "./content-v5";
import { scoringChangelogLegacyDetails } from "./content-legacy";
import { ScoringChangelogSummaryTables } from "./content-summary";

export { scoringAnchorId };

/**
 * Every V9-era entry renders from its structured changelog record, so shipping a
 * new V9 version only requires the entry in
 * `shared/data/methodology-changelogs/safety-score/` — no JSX block here.
 * Pre-V9 versions keep their hand-authored prose modules.
 */
const scoringChangelogV9Details: Record<string, ReactNode> = Object.fromEntries(
  SAFETY_SCORE_METHODOLOGY_CHANGELOG.filter((entry) => entry.version.startsWith("9.")).map((entry) => [
    entry.version,
    <StructuredChangelogDetail key={entry.version} entry={entry} />,
  ]),
);

export const scoringChangelogDetails: Record<string, ReactNode> = {
  ...scoringChangelogV9Details,
  ...scoringChangelogV8Details,
  ...scoringChangelogV729Details,
  ...scoringChangelogV728Details,
  ...scoringChangelogV727Details,
  ...scoringChangelogV70Details,
  ...scoringChangelogV6Details,
  ...scoringChangelogV5Details,
  ...scoringChangelogLegacyDetails,
};

function getScoringChangelogDetail(version: string): ReactNode {
  if (!Object.hasOwn(scoringChangelogDetails, version)) {
    throw new Error(`Missing Safety Score changelog details for ${version}`);
  }
  return scoringChangelogDetails[version];
}

export function ScoringChangelogContent() {
  return (
    <>
      {SAFETY_SCORE_METHODOLOGY_CHANGELOG.map((entry) => (
        <VersionCard key={entry.version} entry={entry}>
          {getScoringChangelogDetail(entry.version)}
        </VersionCard>
      ))}
      <ScoringChangelogSummaryTables />
    </>
  );
}

