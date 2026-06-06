import { MINT_BURN_FLOW_V1 } from "../../data/methodology-changelogs/mint-burn-flow/v1";
import { MINT_BURN_FLOW_V2 } from "../../data/methodology-changelogs/mint-burn-flow/v2";
import { MINT_BURN_FLOW_V3 } from "../../data/methodology-changelogs/mint-burn-flow/v3";
import { MINT_BURN_FLOW_V4 } from "../../data/methodology-changelogs/mint-burn-flow/v4";
import { MINT_BURN_FLOW_V5 } from "../../data/methodology-changelogs/mint-burn-flow/v5";
import { MINT_BURN_FLOW_V6 } from "../../data/methodology-changelogs/mint-burn-flow/v6";
import {
  createMethodologyVersion,
} from "./base";

const mintBurnFlow = createMethodologyVersion({
  currentVersion: "6.12",
  changelogPath: "/methodology/mint-burn-flow-changelog/",
  changelog: [
    ...MINT_BURN_FLOW_V6,
    ...MINT_BURN_FLOW_V5,
    ...MINT_BURN_FLOW_V4,
    ...MINT_BURN_FLOW_V3,
    ...MINT_BURN_FLOW_V2,
    ...MINT_BURN_FLOW_V1,
  ],
});

/** Display-ready Mint/Burn Flow methodology version (with "v" prefix). */
export const MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL = mintBurnFlow.versionLabel;

/** Public changelog route for Mint/Burn Flow methodology history. */
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH = mintBurnFlow.changelogPath;

/** Reconstructed changelog data. */
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG = mintBurnFlow.changelog;
