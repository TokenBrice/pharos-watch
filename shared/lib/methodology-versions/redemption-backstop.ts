import { REDEMPTION_BACKSTOP_V1 } from "../../data/methodology-changelogs/redemption-backstop/v1";
import { REDEMPTION_BACKSTOP_V2 } from "../../data/methodology-changelogs/redemption-backstop/v2";
import { REDEMPTION_BACKSTOP_V3 } from "../../data/methodology-changelogs/redemption-backstop/v3";
import { REDEMPTION_BACKSTOP_V4 } from "../../data/methodology-changelogs/redemption-backstop/v4";
import { createMethodologyVersion } from "./base";
import {
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
} from "./constants";

const redemptionBackstop = createMethodologyVersion({
  currentVersion: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
  changelogPath: REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...REDEMPTION_BACKSTOP_V4,
    ...REDEMPTION_BACKSTOP_V3,
    ...REDEMPTION_BACKSTOP_V2,
    ...REDEMPTION_BACKSTOP_V1,
  ],
});

export {
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Resolve Redemption Backstop methodology version active at a given Unix timestamp (seconds). */
export const getRedemptionBackstopVersionAt = redemptionBackstop.getVersionAt;

/** Reconstructed changelog data. */
export const REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG = redemptionBackstop.changelog;
