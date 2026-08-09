import { MINT_AUTHORITY_V1 } from "../../data/methodology-changelogs/mint-authority/v1";
import { createMethodologyVersion } from "./base";
import {
  MINT_AUTHORITY_METHODOLOGY_PATH,
  MINT_AUTHORITY_METHODOLOGY_VERSION,
} from "./constants";

/**
 * Mint authority has no consumer for the resolved version windows — the label
 * comes straight from `./constants` — so this lane runs the shared machinery
 * purely for its validation: version-format parsing plus the
 * currentVersion-vs-latest-changelog drift guard. The guard inside
 * `createMethodologyVersion` is dev/test only, so assert the invariant here
 * explicitly instead of discarding the result.
 */
const mintAuthority = createMethodologyVersion({
  currentVersion: MINT_AUTHORITY_METHODOLOGY_VERSION,
  changelogPath: MINT_AUTHORITY_METHODOLOGY_PATH,
  changelog: [...MINT_AUTHORITY_V1],
});

const latestMintAuthorityChangelogVersion = mintAuthority.changelog[0]?.version;
if (latestMintAuthorityChangelogVersion !== MINT_AUTHORITY_METHODOLOGY_VERSION) {
  throw new Error(
    `Mint authority methodology version drift: currentVersion="${MINT_AUTHORITY_METHODOLOGY_VERSION}" ` +
      `but latest changelog entry is "${latestMintAuthorityChangelogVersion ?? "(empty changelog)"}".`,
  );
}

export { MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL } from "./constants";
