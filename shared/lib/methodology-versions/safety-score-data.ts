import { SAFETY_SCORE_V1 } from "../../data/methodology-changelogs/safety-score/v1";
import { SAFETY_SCORE_V2 } from "../../data/methodology-changelogs/safety-score/v2";
import { SAFETY_SCORE_V3 } from "../../data/methodology-changelogs/safety-score/v3";
import { SAFETY_SCORE_V4 } from "../../data/methodology-changelogs/safety-score/v4";
import { SAFETY_SCORE_V5 } from "../../data/methodology-changelogs/safety-score/v5";
import { SAFETY_SCORE_V6 } from "../../data/methodology-changelogs/safety-score/v6";
import { SAFETY_SCORE_V7 } from "../../data/methodology-changelogs/safety-score/v7";
import type { MethodologyVersionConfig } from "./base";

export const SAFETY_SCORE_VERSION_CONFIG: MethodologyVersionConfig = {
  currentVersion: "7.29",
  changelogPath: "/methodology/scoring-changelog/",
  changelog: [
    ...SAFETY_SCORE_V7,
    ...SAFETY_SCORE_V6,
    ...SAFETY_SCORE_V5,
    ...SAFETY_SCORE_V4,
    ...SAFETY_SCORE_V3,
    ...SAFETY_SCORE_V2,
    ...SAFETY_SCORE_V1,
  ],
};
