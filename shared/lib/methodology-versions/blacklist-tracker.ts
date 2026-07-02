import { BLACKLIST_TRACKER_V1 } from "../../data/methodology-changelogs/blacklist-tracker/v1";
import { BLACKLIST_TRACKER_V2 } from "../../data/methodology-changelogs/blacklist-tracker/v2";
import { BLACKLIST_TRACKER_V3 } from "../../data/methodology-changelogs/blacklist-tracker/v3";
import { createMethodologyVersion } from "./base";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
} from "./constants";

const blacklistTracker = createMethodologyVersion({
  currentVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  changelogPath: BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...BLACKLIST_TRACKER_V3,
    ...BLACKLIST_TRACKER_V2,
    ...BLACKLIST_TRACKER_V1,
  ],
});

export {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Reconstructed changelog data. */
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG = blacklistTracker.changelog;

/** Resolve Blacklist Tracker methodology version active at a given Unix timestamp (seconds). */
export const getBlacklistTrackerMethodologyVersionAt = blacklistTracker.getVersionAt;
