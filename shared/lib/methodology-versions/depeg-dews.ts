import { DEPEG_DEWS_V1 } from "../../data/methodology-changelogs/depeg-dews/v1";
import { DEPEG_DEWS_V2 } from "../../data/methodology-changelogs/depeg-dews/v2";
import { DEPEG_DEWS_V3 } from "../../data/methodology-changelogs/depeg-dews/v3";
import { DEPEG_DEWS_V4 } from "../../data/methodology-changelogs/depeg-dews/v4";
import { DEPEG_DEWS_V5 } from "../../data/methodology-changelogs/depeg-dews/v5";
import { DEPEG_DEWS_V6 } from "../../data/methodology-changelogs/depeg-dews/v6";
import { createMethodologyVersion } from "./base";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
} from "./constants";

const depegDews = createMethodologyVersion({
  currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION,
  changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...DEPEG_DEWS_V6,
    ...DEPEG_DEWS_V5,
    ...DEPEG_DEWS_V4,
    ...DEPEG_DEWS_V3,
    ...DEPEG_DEWS_V2,
    ...DEPEG_DEWS_V1,
  ],
});

export {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Reconstructed changelog data. */
export const DEPEG_DEWS_METHODOLOGY_CHANGELOG = depegDews.changelog;

/** Resolve Depeg Tracker + DEWS methodology version active at a given Unix timestamp (seconds). */
export const getDepegDewsMethodologyVersionAt = depegDews.getVersionAt;
