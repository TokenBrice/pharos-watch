/**
 * Shared numeric constants for the primary pricing pipeline.
 *
 * Kept runtime-neutral so both worker code and future shared-layer code
 * can import without pulling in Cloudflare-specific dependencies.
 */

/**
 * Maximum allowed inter-source price divergence (in basis points) before
 * two sources are treated as disagreeing during primary consensus.
 * Used both as the default for `buildPrimarySourceCandidates` and as the
 * threshold fed into `computePriceConsensus` from the primary orchestrator
 * and GT-probe re-run.
 */
export const DIVERGENCE_THRESHOLD_BPS = 50;
