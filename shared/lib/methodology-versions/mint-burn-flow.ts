import { MINT_BURN_FLOW_V1 } from "../../data/methodology-changelogs/mint-burn-flow/v1";
import { MINT_BURN_FLOW_V2 } from "../../data/methodology-changelogs/mint-burn-flow/v2";
import { MINT_BURN_FLOW_V3 } from "../../data/methodology-changelogs/mint-burn-flow/v3";
import { MINT_BURN_FLOW_V4 } from "../../data/methodology-changelogs/mint-burn-flow/v4";
import { MINT_BURN_FLOW_V5 } from "../../data/methodology-changelogs/mint-burn-flow/v5";
import { MINT_BURN_FLOW_V6 } from "../../data/methodology-changelogs/mint-burn-flow/v6";
import { createMethodologyVersion } from "./base";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION,
} from "./constants";

const mintBurnFlow = createMethodologyVersion({
  currentVersion: MINT_BURN_FLOW_METHODOLOGY_VERSION,
  changelogPath: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...MINT_BURN_FLOW_V6,
    ...MINT_BURN_FLOW_V5,
    ...MINT_BURN_FLOW_V4,
    ...MINT_BURN_FLOW_V3,
    ...MINT_BURN_FLOW_V2,
    ...MINT_BURN_FLOW_V1,
  ],
});

export {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Reconstructed changelog data. */
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG = mintBurnFlow.changelog;
