import { LIQUIDITY_SCORE_V1 } from "../../data/methodology-changelogs/liquidity-score/v1";
import { LIQUIDITY_SCORE_V2 } from "../../data/methodology-changelogs/liquidity-score/v2";
import { LIQUIDITY_SCORE_V3 } from "../../data/methodology-changelogs/liquidity-score/v3";
import { LIQUIDITY_SCORE_V4 } from "../../data/methodology-changelogs/liquidity-score/v4";
import { LIQUIDITY_SCORE_V5 } from "../../data/methodology-changelogs/liquidity-score/v5";
import { createMethodologyVersion } from "./base";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION,
} from "./constants";

const liquidity = createMethodologyVersion({
  currentVersion: LIQUIDITY_METHODOLOGY_VERSION,
  changelogPath: LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...LIQUIDITY_SCORE_V5,
    ...LIQUIDITY_SCORE_V4,
    ...LIQUIDITY_SCORE_V3,
    ...LIQUIDITY_SCORE_V2,
    ...LIQUIDITY_SCORE_V1,
  ],
});

export {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Reconstructed changelog data. */
export const LIQUIDITY_METHODOLOGY_CHANGELOG = liquidity.changelog;

/** Resolve Liquidity Score methodology version active at a given Unix timestamp (seconds). */
export const getLiquidityMethodologyVersionAt = liquidity.getVersionAt;
