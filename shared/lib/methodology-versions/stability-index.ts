import { STABILITY_INDEX_V1 } from "../../data/methodology-changelogs/stability-index/v1";
import { STABILITY_INDEX_V2 } from "../../data/methodology-changelogs/stability-index/v2";
import { STABILITY_INDEX_V3 } from "../../data/methodology-changelogs/stability-index/v3";
import { createMethodologyVersion } from "./base";

const psi = createMethodologyVersion({
  currentVersion: "3.5",
  changelogPath: "/methodology/stability-index-changelog/",
  changelog: [
    ...STABILITY_INDEX_V3,
    ...STABILITY_INDEX_V2,
    ...STABILITY_INDEX_V1,
  ],
});

/** Canonical PSI methodology version (no "v" prefix). */
export const PSI_METHODOLOGY_VERSION = psi.currentVersion;

/** Display-ready PSI methodology version (with "v" prefix). */
export const PSI_METHODOLOGY_VERSION_LABEL = psi.versionLabel;

/** Public changelog route for PSI methodology history. */
export const PSI_METHODOLOGY_CHANGELOG_PATH = psi.changelogPath;

/** Reconstructed changelog data. */
export const PSI_METHODOLOGY_CHANGELOG = psi.changelog;

/** Resolve PSI methodology version active at a given Unix timestamp (seconds). */
export const getPsiMethodologyVersionAt = psi.getVersionAt;
