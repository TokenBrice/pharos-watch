import { YIELD_METHODOLOGY_V1 } from "../../data/methodology-changelogs/yield-methodology/v1";
import { YIELD_METHODOLOGY_V2 } from "../../data/methodology-changelogs/yield-methodology/v2";
import { YIELD_METHODOLOGY_V3 } from "../../data/methodology-changelogs/yield-methodology/v3";
import { YIELD_METHODOLOGY_V4 } from "../../data/methodology-changelogs/yield-methodology/v4";
import { YIELD_METHODOLOGY_V5 } from "../../data/methodology-changelogs/yield-methodology/v5";
import { YIELD_METHODOLOGY_V6 } from "../../data/methodology-changelogs/yield-methodology/v6";
import { YIELD_METHODOLOGY_V7 } from "../../data/methodology-changelogs/yield-methodology/v7";
import { YIELD_METHODOLOGY_V8 } from "../../data/methodology-changelogs/yield-methodology/v8";
import { createMethodologyVersion } from "./base";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
} from "./constants";

const yieldMethodology = createMethodologyVersion({
  currentVersion: YIELD_METHODOLOGY_VERSION,
  changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...YIELD_METHODOLOGY_V8,
    ...YIELD_METHODOLOGY_V7,
    ...YIELD_METHODOLOGY_V6,
    ...YIELD_METHODOLOGY_V5,
    ...YIELD_METHODOLOGY_V4,
    ...YIELD_METHODOLOGY_V3,
    ...YIELD_METHODOLOGY_V2,
    ...YIELD_METHODOLOGY_V1,
  ],
});

export {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Reconstructed changelog data. */
export const YIELD_METHODOLOGY_CHANGELOG = yieldMethodology.changelog;
