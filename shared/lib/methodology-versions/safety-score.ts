import { SAFETY_SCORE_V1 } from "../../data/methodology-changelogs/safety-score/v1";
import { SAFETY_SCORE_V2 } from "../../data/methodology-changelogs/safety-score/v2";
import { SAFETY_SCORE_V3 } from "../../data/methodology-changelogs/safety-score/v3";
import { SAFETY_SCORE_V4 } from "../../data/methodology-changelogs/safety-score/v4";
import { SAFETY_SCORE_V5 } from "../../data/methodology-changelogs/safety-score/v5";
import { SAFETY_SCORE_V6 } from "../../data/methodology-changelogs/safety-score/v6";
import { SAFETY_SCORE_V7 } from "../../data/methodology-changelogs/safety-score/v7";
import { SAFETY_SCORE_V8 } from "../../data/methodology-changelogs/safety-score/v8";
import { createMethodologyVersion, toMethodologyVersionLabel } from "./base";
import currentVersion from "./current-version.json";

const safetyScore = createMethodologyVersion({
  currentVersion: currentVersion.currentVersion,
  changelogPath: "/methodology/scoring-changelog/",
  changelog: [
    ...SAFETY_SCORE_V8,
    ...SAFETY_SCORE_V7,
    ...SAFETY_SCORE_V6,
    ...SAFETY_SCORE_V5,
    ...SAFETY_SCORE_V4,
    ...SAFETY_SCORE_V3,
    ...SAFETY_SCORE_V2,
    ...SAFETY_SCORE_V1,
  ],
});

export const SAFETY_SCORE_METHODOLOGY_VERSION = safetyScore.currentVersion;
export const SAFETY_SCORE_METHODOLOGY_VERSION_LABEL = safetyScore.versionLabel;
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH = safetyScore.changelogPath;
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG = safetyScore.changelog;
export const getSafetyScoreVersionAt = safetyScore.getVersionAt;
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS = SAFETY_SCORE_METHODOLOGY_CHANGELOG.map(
  (entry) => toMethodologyVersionLabel(entry.version),
);
