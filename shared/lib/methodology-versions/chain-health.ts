import { CHAIN_HEALTH_V1 } from "../../data/methodology-changelogs/chain-health/v1";
import { createMethodologyVersion } from "./base";

const chainHealth = createMethodologyVersion({
  currentVersion: "1.4",
  changelogPath: "/methodology/chain-health-changelog/",
  changelog: [
    ...CHAIN_HEALTH_V1,
  ],
});

/** Canonical Chain Health methodology version (no "v" prefix). */
export const CHAIN_HEALTH_METHODOLOGY_VERSION = chainHealth.currentVersion;

/** Display-ready Chain Health methodology version (with "v" prefix). */
export const CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL = chainHealth.versionLabel;

/** Public changelog route for Chain Health methodology history. */
export const CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH = chainHealth.changelogPath;

/** Changelog data. */
export const CHAIN_HEALTH_METHODOLOGY_CHANGELOG = chainHealth.changelog;

/** Resolve Chain Health methodology version active at a given Unix timestamp (seconds). */
export const getChainHealthMethodologyVersionAt = chainHealth.getVersionAt;
