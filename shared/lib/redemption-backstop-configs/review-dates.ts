/** Cross-cutting redemption-backstop review dates shared across config files.
 *  Per-domain alias names (e.g. `REVIEWED_DIRECT_REDEMPTION_AT`) re-bind these
 *  locally where the name carries domain meaning. */

/** First-wave direct/basket/queue redemption review pass. */
export const REVIEWED_FIRST_WAVE_AT = "2026-03-23";
/** Alias for the first-wave date, used by direct-redemption config files to
 *  signal that a direct-redemption route was reviewed in the first wave. */
export const REVIEWED_DIRECT_REDEMPTION_AT = REVIEWED_FIRST_WAVE_AT;
/** Remediation pass that backfilled reviewed docs and dates. */
export const REVIEWED_REMEDIATION_AT = "2026-03-30";
/** Wrapper/queue/stablecoin-redeem expansion review wave (late April). */
export const REVIEWED_WRAPPER_WAVE_AT = "2026-04-21";
/** May batch covering HBD, Reserve Protocol DTF, non-USD, and stablecoin configs. */
export const REVIEWED_MAY_BATCH_AT = "2026-05-05";
/** May yield/coverage expansion wave — Mento CDP, offchain issuer coverage, yield stablecoins. */
export const REVIEWED_YIELD_COVERAGE_WAVE_AT = "2026-05-11";
/** Broad stablecoin-coverage audit pass. */
export const REVIEWED_STABLECOIN_AUDIT_AT = "2026-05-12";
/** Follow-up remediation pass after the stablecoin audit. */
export const REVIEWED_FOLLOWUP_REMEDIATION_AT = "2026-05-13";
/** Exit-credit review wave: documented fee bounds and route remodels. */
export const REVIEWED_EXIT_CREDIT_WAVE_AT = "2026-08-12";
/** Second exit-credit wave: further fee bounds and newly configured PSM routes. */
export const REVIEWED_EXIT_CREDIT_WAVE2_AT = "2026-08-12";
/** Third exit-credit wave: collateral-redeem fee bounds and issuer-route coverage. */
export const REVIEWED_EXIT_CREDIT_WAVE3_AT = "2026-08-12";
