import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { MethodologySectionShell } from "../../methodology-shared";
import { PEGSCORE_DEWS_SECTION_CONTENT } from "@/lib/methodology-content";
import { PegScoreDewsOverview } from "./pegscore-dews-overview";
import { PegScoreDewsTechnicalDetails } from "./pegscore-dews-technical-details";
import { METHODOLOGY_SECTION_ACCENT_CLASSES } from "@shared/lib/classification";

export function PegScoreDewsMethodologySection() {
  return (
    <MethodologySectionShell
      id={PEGSCORE_DEWS_SECTION_CONTENT.id}
      title={PEGSCORE_DEWS_SECTION_CONTENT.title}
      versionBadge={{ label: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL }}
      changelogPath={DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when depeg thresholds, confirmation policy, peg-score formula terms, or DEWS signal composition or score-affecting input semantics (including TVL-measurement comparability) change."
      changelogClassName={METHODOLOGY_SECTION_ACCENT_CLASSES.pegscoreDews.changelogHover}
    >
      <PegScoreDewsOverview />
      <PegScoreDewsTechnicalDetails />
    </MethodologySectionShell>
  );
}
