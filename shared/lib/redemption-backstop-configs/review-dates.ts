/** Cross-cutting redemption-backstop review dates shared across config files.
 *  Per-domain alias names (e.g. `REVIEWED_DIRECT_REDEMPTION_AT`) re-bind these
 *  locally where the name carries domain meaning. */

/** First-wave direct/basket/queue redemption review pass. */
export const REVIEWED_FIRST_WAVE_AT = "2026-03-23";
/** Remediation pass that backfilled reviewed docs and dates. */
export const REVIEWED_REMEDIATION_AT = "2026-03-30";
/** Broad stablecoin-coverage audit pass. */
export const REVIEWED_STABLECOIN_AUDIT_AT = "2026-05-12";
/** Follow-up remediation pass after the stablecoin audit. */
export const REVIEWED_FOLLOWUP_REMEDIATION_AT = "2026-05-13";
