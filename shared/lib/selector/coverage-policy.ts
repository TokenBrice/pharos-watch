/**
 * Coverage and confidence thresholds. The snapshot read path
 * (`snapshot-normalize.ts`) re-derives the same sparse/uneven/low-confidence
 * verdicts to cross-check stored payloads, so both sites must consume these
 * named values. Only the constants are shared: the engine measures skipped
 * coins against the full universe length, the read path against the active
 * count recorded in the stored blob — those denominators stay separate.
 *
 * This module must stay dependency-free: snapshot reads (including the
 * `selector-snapshot` GET validation path) import it directly and must not
 * pull in the engine's execution graph.
 */
export const COVERAGE_SPARSE_FRACTION = 0.25;
export const COVERAGE_UNEVEN_FRACTION = 0.15;
export const LOW_CONFIDENCE_THRESHOLD = 70;
