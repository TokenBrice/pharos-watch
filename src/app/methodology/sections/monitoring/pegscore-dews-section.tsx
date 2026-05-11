import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-dews-version";
import { MethodologySectionShell } from "../../methodology-shared";
import { PEGSCORE_DEWS_SECTION_CONTENT } from "../methodology-content";
import { PegScoreDewsOverview } from "./pegscore-dews-overview";
import { PegScoreDewsTechnicalDetails } from "./pegscore-dews-technical-details";

export function PegScoreDewsMethodologySection() {
  return (
    <MethodologySectionShell
      id={PEGSCORE_DEWS_SECTION_CONTENT.id}
      title={PEGSCORE_DEWS_SECTION_CONTENT.title}
      versionLabel={DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}
      changelogPath={DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when depeg thresholds, confirmation policy, peg-score formula terms, or DEWS signal composition or score-affecting input semantics change."
      accentClassName="border-l-amber-500"
      badgeClassName="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      changelogClassName="hover:text-amber-700 dark:text-amber-400"
    >
      <PegScoreDewsOverview />
      <PegScoreDewsTechnicalDetails />
    </MethodologySectionShell>
  );
}
