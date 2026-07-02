import { CHAIN_HEALTH_V1 } from "../../data/methodology-changelogs/chain-health/v1";
import { createMethodologyVersion } from "./base";
import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION,
} from "./constants";

const chainHealth = createMethodologyVersion({
  currentVersion: CHAIN_HEALTH_METHODOLOGY_VERSION,
  changelogPath: CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...CHAIN_HEALTH_V1,
  ],
});

export {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Changelog data. */
export const CHAIN_HEALTH_METHODOLOGY_CHANGELOG = chainHealth.changelog;

/** Resolve Chain Health methodology version active at a given Unix timestamp (seconds). */
export const getChainHealthMethodologyVersionAt = chainHealth.getVersionAt;
