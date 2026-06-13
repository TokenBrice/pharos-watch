import { MINT_AUTHORITY_V1 } from "../../data/methodology-changelogs/mint-authority/v1";
import { createMethodologyVersion } from "./base";

const mintAuthority = createMethodologyVersion({
  currentVersion: "1.1",
  changelogPath: "/methodology/#mint-authority-score",
  changelog: [...MINT_AUTHORITY_V1],
});

/** Canonical Mint Authority Score methodology version (no "v" prefix). */
export const MINT_AUTHORITY_METHODOLOGY_VERSION = mintAuthority.currentVersion;

/** Display-ready Mint Authority Score methodology version (with "v" prefix). */
export const MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL = mintAuthority.versionLabel;

/**
 * Public methodology anchor for Mint Authority Score — an in-page #anchor on /methodology, not a
 * dedicated changelog route, so it is intentionally named _METHODOLOGY_PATH (not _METHODOLOGY_CHANGELOG_PATH).
 */
export const MINT_AUTHORITY_METHODOLOGY_PATH = mintAuthority.changelogPath;
