import { YIELD_METHODOLOGY_V1 } from "@shared/data/methodology-changelogs/yield-methodology/v1";
import { YIELD_METHODOLOGY_V2 } from "@shared/data/methodology-changelogs/yield-methodology/v2";
import { YIELD_METHODOLOGY_V3 } from "@shared/data/methodology-changelogs/yield-methodology/v3";
import { YIELD_METHODOLOGY_V4 } from "@shared/data/methodology-changelogs/yield-methodology/v4";
import { YIELD_METHODOLOGY_V5 } from "@shared/data/methodology-changelogs/yield-methodology/v5";
import { YIELD_METHODOLOGY_V6 } from "@shared/data/methodology-changelogs/yield-methodology/v6";
import { YIELD_METHODOLOGY_V7 } from "@shared/data/methodology-changelogs/yield-methodology/v7";
import { YIELD_METHODOLOGY_V8 } from "@shared/data/methodology-changelogs/yield-methodology/v8";
import { createMethodologyVersion } from "./base";

const yieldMethodology = createMethodologyVersion({
  currentVersion: "8.12",
  changelogPath: "/methodology/yield-changelog/",
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

/** Display-ready Yield Intelligence methodology version (with "v" prefix). */
export const YIELD_METHODOLOGY_VERSION = yieldMethodology.currentVersion;

/** Display-ready Yield Intelligence methodology version (with "v" prefix). */
export const YIELD_METHODOLOGY_VERSION_LABEL = yieldMethodology.versionLabel;

/** Public changelog route for Yield Intelligence methodology history. */
export const YIELD_METHODOLOGY_CHANGELOG_PATH = yieldMethodology.changelogPath;

/** Reconstructed changelog data. */
export const YIELD_METHODOLOGY_CHANGELOG = yieldMethodology.changelog;
