import { LIQUIDITY_SCORE_V1 } from "../../data/methodology-changelogs/liquidity-score/v1";
import { LIQUIDITY_SCORE_V2 } from "../../data/methodology-changelogs/liquidity-score/v2";
import { LIQUIDITY_SCORE_V3 } from "../../data/methodology-changelogs/liquidity-score/v3";
import { LIQUIDITY_SCORE_V4 } from "../../data/methodology-changelogs/liquidity-score/v4";
import { LIQUIDITY_SCORE_V5 } from "../../data/methodology-changelogs/liquidity-score/v5";
import { createMethodologyVersion } from "./base";

const liquidity = createMethodologyVersion({
  currentVersion: "5.8",
  changelogPath: "/methodology/liquidity-score-changelog/",
  changelog: [
    ...LIQUIDITY_SCORE_V5,
    ...LIQUIDITY_SCORE_V4,
    ...LIQUIDITY_SCORE_V3,
    ...LIQUIDITY_SCORE_V2,
    ...LIQUIDITY_SCORE_V1,
  ],
});

/** Canonical Liquidity Score methodology version (no "v" prefix). */
export const LIQUIDITY_METHODOLOGY_VERSION = liquidity.currentVersion;

/** Display-ready Liquidity Score methodology version (with "v" prefix). */
export const LIQUIDITY_METHODOLOGY_VERSION_LABEL = liquidity.versionLabel;

/** Public changelog route for Liquidity Score methodology history. */
export const LIQUIDITY_METHODOLOGY_CHANGELOG_PATH = liquidity.changelogPath;

/** Reconstructed changelog data. */
export const LIQUIDITY_METHODOLOGY_CHANGELOG = liquidity.changelog;

/** Resolve Liquidity Score methodology version active at a given Unix timestamp (seconds). */
export const getLiquidityMethodologyVersionAt = liquidity.getVersionAt;
