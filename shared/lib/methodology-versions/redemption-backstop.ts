import { REDEMPTION_BACKSTOP_V1 } from "../../data/methodology-changelogs/redemption-backstop/v1";
import { REDEMPTION_BACKSTOP_V2 } from "../../data/methodology-changelogs/redemption-backstop/v2";
import { REDEMPTION_BACKSTOP_V3 } from "../../data/methodology-changelogs/redemption-backstop/v3";
import { REDEMPTION_BACKSTOP_V4 } from "../../data/methodology-changelogs/redemption-backstop/v4";
import { createMethodologyVersion, toMethodologyVersionLabel } from "./base";

const redemptionBackstop = createMethodologyVersion({
  currentVersion: "4.11",
  changelogPath: "/methodology/#safety-scores-methodology",
  changelog: [
    ...REDEMPTION_BACKSTOP_V4,
    ...REDEMPTION_BACKSTOP_V3,
    ...REDEMPTION_BACKSTOP_V2,
    ...REDEMPTION_BACKSTOP_V1,
  ],
});

/** Canonical Redemption Backstop methodology version (no "v" prefix). */
export const REDEMPTION_BACKSTOP_METHODOLOGY_VERSION = redemptionBackstop.currentVersion;

/** Display-ready Redemption Backstop methodology version (with "v" prefix). */
export const REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL = redemptionBackstop.versionLabel;

/**
 * Public methodology anchor for Redemption Backstop — an in-page #anchor on /methodology, not a
 * dedicated changelog route, so it is intentionally named _METHODOLOGY_PATH (not _METHODOLOGY_CHANGELOG_PATH).
 */
export const REDEMPTION_BACKSTOP_METHODOLOGY_PATH = redemptionBackstop.changelogPath;

/** Resolve Redemption Backstop methodology version active at a given Unix timestamp (seconds). */
export const getRedemptionBackstopVersionAt = redemptionBackstop.getVersionAt;

/** Display-ready label for a historical Redemption Backstop methodology version. */
export const toRedemptionBackstopVersionLabel = toMethodologyVersionLabel;

/** Reconstructed changelog data. */
export const REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG = redemptionBackstop.changelog;
