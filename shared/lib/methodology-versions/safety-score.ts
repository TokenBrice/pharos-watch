import { SAFETY_SCORE_V1 } from "../../data/methodology-changelogs/safety-score/v1";
import { SAFETY_SCORE_V2 } from "../../data/methodology-changelogs/safety-score/v2";
import { SAFETY_SCORE_V3 } from "../../data/methodology-changelogs/safety-score/v3";
import { SAFETY_SCORE_V4 } from "../../data/methodology-changelogs/safety-score/v4";
import { SAFETY_SCORE_V5 } from "../../data/methodology-changelogs/safety-score/v5";
import { SAFETY_SCORE_V6 } from "../../data/methodology-changelogs/safety-score/v6";
import { SAFETY_SCORE_V7 } from "../../data/methodology-changelogs/safety-score/v7";
import { SAFETY_SCORE_V8 } from "../../data/methodology-changelogs/safety-score/v8";
import {
  SAFETY_SCORE_V9_ACTIVATION,
  SAFETY_SCORE_V9_CAUSAL_RESPONSIBILITY,
  SAFETY_SCORE_V9_ROUTE_CAPACITY,
  SAFETY_SCORE_V9_UNRECOGNIZED_CHAIN_LABEL_TOLERANCE,
} from "../../data/methodology-changelogs/safety-score/v9-activation";
import { createMethodologyVersion } from "./base";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION,
} from "./constants";

const safetyScore = createMethodologyVersion({
  currentVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
  changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    SAFETY_SCORE_V9_UNRECOGNIZED_CHAIN_LABEL_TOLERANCE,
    SAFETY_SCORE_V9_CAUSAL_RESPONSIBILITY,
    SAFETY_SCORE_V9_ROUTE_CAPACITY,
    SAFETY_SCORE_V9_ACTIVATION,
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

export {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "./constants";
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG = safetyScore.changelog;
export const getSafetyScoreVersionAt = safetyScore.getVersionAt;
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS = safetyScore.versionLabels;
