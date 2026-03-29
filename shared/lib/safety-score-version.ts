import { createMethodologyVersion } from "./methodology-version";
import { SAFETY_SCORE_VERSION_CONFIG } from "./safety-score-version-data";

const safetyScore = createMethodologyVersion(SAFETY_SCORE_VERSION_CONFIG);

export const SAFETY_SCORE_VERSION = safetyScore.currentVersion;
export const SAFETY_SCORE_VERSION_LABEL = safetyScore.versionLabel;
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH = safetyScore.changelogPath;
export const SAFETY_SCORE_CHANGELOG = safetyScore.changelog;
export const getSafetyScoreVersionAt = safetyScore.getVersionAt;
export const SAFETY_SCORE_CHANGELOG_NAV_VERSIONS = SAFETY_SCORE_CHANGELOG.map(
  (entry) => `v${entry.version}`,
);
