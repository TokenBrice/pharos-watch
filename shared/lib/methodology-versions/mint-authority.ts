import { MINT_AUTHORITY_V1 } from "../../data/methodology-changelogs/mint-authority/v1";
import { createMethodologyVersion } from "./base";
import {
  MINT_AUTHORITY_METHODOLOGY_PATH,
  MINT_AUTHORITY_METHODOLOGY_VERSION,
} from "./constants";

createMethodologyVersion({
  currentVersion: MINT_AUTHORITY_METHODOLOGY_VERSION,
  changelogPath: MINT_AUTHORITY_METHODOLOGY_PATH,
  changelog: [...MINT_AUTHORITY_V1],
});

export {
  MINT_AUTHORITY_METHODOLOGY_PATH,
  MINT_AUTHORITY_METHODOLOGY_VERSION,
  MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL,
} from "./constants";
