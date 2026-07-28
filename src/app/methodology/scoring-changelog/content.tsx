import type { ReactNode } from "react";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { SAFETY_SCORE_METHODOLOGY_CHANGELOG } from "@shared/lib/safety-score-version";
import {
  SAFETY_SCORE_V9_ACTIVATION,
  SAFETY_SCORE_V9_ROUTE_CAPACITY,
} from "@shared/data/methodology-changelogs/safety-score/v9-activation";
import { scoringAnchorId, VersionCard } from "./content-shared";
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

export const scoringChangelogDetails: Record<string, ReactNode> = {
  "9.01": (
    <>
      <p>{SAFETY_SCORE_V9_ROUTE_CAPACITY.summary}</p>
      <ul className="list-disc list-inside space-y-1">
        {SAFETY_SCORE_V9_ROUTE_CAPACITY.impact.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  ),
  "9.0": (
    <>
      <p>{SAFETY_SCORE_V9_ACTIVATION.summary}</p>
      <ul className="list-disc list-inside space-y-1">
        {SAFETY_SCORE_V9_ACTIVATION.impact.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  ),
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

export { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL };
