import { BLACKLIST_TRACKER_V1 } from "../../data/methodology-changelogs/blacklist-tracker/v1";
import { BLACKLIST_TRACKER_V2 } from "../../data/methodology-changelogs/blacklist-tracker/v2";
import { BLACKLIST_TRACKER_V3 } from "../../data/methodology-changelogs/blacklist-tracker/v3";
import { createMethodologyVersion } from "./base";

const blacklistTracker = createMethodologyVersion({
  currentVersion: "3.9973",
  changelogPath: "/methodology/blacklist-tracker-changelog/",
  changelog: [
    ...BLACKLIST_TRACKER_V3,
    ...BLACKLIST_TRACKER_V2,
    ...BLACKLIST_TRACKER_V1,
  ],
});

/** Canonical Blacklist Tracker methodology version (no "v" prefix). */
export const BLACKLIST_TRACKER_METHODOLOGY_VERSION = blacklistTracker.currentVersion;

/** Display-ready Blacklist Tracker methodology version (with "v" prefix). */
export const BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL = blacklistTracker.versionLabel;

/** Public changelog route for Blacklist Tracker methodology history. */
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH = blacklistTracker.changelogPath;

/** Reconstructed changelog data. */
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG = blacklistTracker.changelog;

/** Resolve Blacklist Tracker methodology version active at a given Unix timestamp (seconds). */
export const getBlacklistTrackerMethodologyVersionAt = blacklistTracker.getVersionAt;
