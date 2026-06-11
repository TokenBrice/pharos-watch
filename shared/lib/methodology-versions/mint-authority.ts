import { MINT_AUTHORITY_V1 } from "../../data/methodology-changelogs/mint-authority/v1";
import { createMethodologyVersion, toMethodologyVersionLabel } from "./base";

const mintAuthority = createMethodologyVersion({
  currentVersion: "1.0",
  changelogPath: "/methodology/#mint-authority-score",
  changelog: [...MINT_AUTHORITY_V1],
});

/** Canonical Mint Authority Score methodology version (no "v" prefix). */
export const MINT_AUTHORITY_METHODOLOGY_VERSION = mintAuthority.currentVersion;

/** Display-ready Mint Authority Score methodology version (with "v" prefix). */
export const MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL = mintAuthority.versionLabel;

/** Public methodology route for Mint Authority Score methodology. */
export const MINT_AUTHORITY_METHODOLOGY_PATH = mintAuthority.changelogPath;

/** Resolve Mint Authority Score methodology version active at a given Unix timestamp (seconds). */
export const getMintAuthorityMethodologyVersionAt = mintAuthority.getVersionAt;

/** Display-ready label for a historical Mint Authority Score methodology version. */
export const toMintAuthorityMethodologyVersionLabel = toMethodologyVersionLabel;

/** Machine-readable Mint Authority Score changelog data. */
export const MINT_AUTHORITY_METHODOLOGY_CHANGELOG = mintAuthority.changelog;
