import currentSafetyScoreVersion from "./current-version.json";

function methodologyLabel(version: string): string {
  return `v${version}`;
}

export const BLACKLIST_TRACKER_METHODOLOGY_VERSION = "3.9972";
export const BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL = methodologyLabel(BLACKLIST_TRACKER_METHODOLOGY_VERSION);
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH = "/methodology/blacklist-tracker-changelog/";

export const CHAIN_HEALTH_METHODOLOGY_VERSION = "1.4";
export const CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL = methodologyLabel(CHAIN_HEALTH_METHODOLOGY_VERSION);
export const CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH = "/methodology/chain-health-changelog/";

export const DEPEG_DEWS_METHODOLOGY_VERSION = "6.095";
export const DEPEG_DEWS_METHODOLOGY_VERSION_LABEL = methodologyLabel(DEPEG_DEWS_METHODOLOGY_VERSION);
export const DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH = "/methodology/depeg-changelog/";

export const DDR_METHODOLOGY_VERSION = "3.04";
export const DDR_METHODOLOGY_VERSION_LABEL = methodologyLabel(DDR_METHODOLOGY_VERSION);
export const DDR_METHODOLOGY_CHANGELOG_PATH = "/methodology/depeg-resolver-changelog/";

export const LIQUIDITY_METHODOLOGY_VERSION = "5.84";
export const LIQUIDITY_METHODOLOGY_VERSION_LABEL = methodologyLabel(LIQUIDITY_METHODOLOGY_VERSION);
export const LIQUIDITY_METHODOLOGY_CHANGELOG_PATH = "/methodology/liquidity-score-changelog/";

export const MINT_AUTHORITY_METHODOLOGY_VERSION = "1.2";
export const MINT_AUTHORITY_METHODOLOGY_VERSION_LABEL = methodologyLabel(MINT_AUTHORITY_METHODOLOGY_VERSION);
export const MINT_AUTHORITY_METHODOLOGY_PATH = "/methodology/#mint-authority-score";

export const MINT_BURN_FLOW_METHODOLOGY_VERSION = "6.17";
export const MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL = methodologyLabel(MINT_BURN_FLOW_METHODOLOGY_VERSION);
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH = "/methodology/mint-burn-flow-changelog/";

export const PRICING_PIPELINE_METHODOLOGY_VERSION = "6.191";
export const PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL = methodologyLabel(PRICING_PIPELINE_METHODOLOGY_VERSION);
export const PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH = "/methodology/pricing-pipeline-changelog/";

export const REDEMPTION_BACKSTOP_METHODOLOGY_VERSION = "4.17";
export const REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL = methodologyLabel(REDEMPTION_BACKSTOP_METHODOLOGY_VERSION);
export const REDEMPTION_BACKSTOP_METHODOLOGY_PATH = "/methodology/#safety-scores-methodology";

export const SAFETY_SCORE_METHODOLOGY_VERSION = currentSafetyScoreVersion.currentVersion;
export const SAFETY_SCORE_METHODOLOGY_VERSION_LABEL = methodologyLabel(SAFETY_SCORE_METHODOLOGY_VERSION);
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH = "/methodology/scoring-changelog/";

export const PSI_METHODOLOGY_VERSION = "3.5";
export const PSI_METHODOLOGY_VERSION_LABEL = methodologyLabel(PSI_METHODOLOGY_VERSION);
export const PSI_METHODOLOGY_CHANGELOG_PATH = "/methodology/stability-index-changelog/";

export const YIELD_METHODOLOGY_VERSION = "8.298";
export const YIELD_METHODOLOGY_VERSION_LABEL = methodologyLabel(YIELD_METHODOLOGY_VERSION);
export const YIELD_METHODOLOGY_CHANGELOG_PATH = "/methodology/yield-changelog/";
