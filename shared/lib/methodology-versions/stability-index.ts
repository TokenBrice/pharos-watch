import { STABILITY_INDEX_V1 } from "../../data/methodology-changelogs/stability-index/v1";
import { STABILITY_INDEX_V2 } from "../../data/methodology-changelogs/stability-index/v2";
import { STABILITY_INDEX_V3 } from "../../data/methodology-changelogs/stability-index/v3";
import { createMethodologyVersion } from "./base";
import { PSI_METHODOLOGY_CHANGELOG_PATH } from "./constants";

const PSI_METHODOLOGY_VERSION = "3.61";
const PSI_METHODOLOGY_VERSION_LABEL = `v${PSI_METHODOLOGY_VERSION}`;

const psi = createMethodologyVersion({
  currentVersion: PSI_METHODOLOGY_VERSION,
  changelogPath: PSI_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...STABILITY_INDEX_V3,
    ...STABILITY_INDEX_V2,
    ...STABILITY_INDEX_V1,
  ],
});

export {
  PSI_METHODOLOGY_CHANGELOG_PATH,
} from "./constants";
export { PSI_METHODOLOGY_VERSION, PSI_METHODOLOGY_VERSION_LABEL };

/** Reconstructed changelog data. */
export const PSI_METHODOLOGY_CHANGELOG = psi.changelog;

/** Resolve PSI methodology version active at a given Unix timestamp (seconds). */
export const getPsiMethodologyVersionAt = psi.getVersionAt;
