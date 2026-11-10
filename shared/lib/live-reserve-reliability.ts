/**
 * Degraded-warning codes that a live-reserve adapter emits deliberately, by
 * construction, on every successful read — a structural limit of the source,
 * not an operational failure. A degraded attempt whose only degraded-effect
 * warnings are in this list counts as `degradedByDesign` in the 30-day adapter
 * reliability rollup, and therefore toward its `successRate`.
 *
 * This list affects only that operational rollup. It does not change sync
 * status, scoring admission, per-config warning allowlists or feed reviews:
 * the warning still degrades the snapshot everywhere else.
 */
export const LIVE_RESERVE_STRUCTURAL_DEGRADED_WARNING_CODES = [
  // chainlink-nav / chronicle-nav `navScope: "portfolio"`: the NAV values the
  // portfolio but never verifies its composition.
  "nav-portfolio-composition-unverified",
] as const;

/**
 * Structural score-ineligibility for the completed post-sync observer only
 * (owner ruling 2026-11-04): a completed reserve observation whose degraded
 * warnings are all in this list is a correct steady-state outcome, kept as
 * quality metadata instead of degrading the observer. It adds reviewed
 * economic findings to the by-design source limits above; it never feeds the
 * 30-day reliability rollup, sync status, scoring admission or feed reviews.
 */
export const LIVE_RESERVE_STRUCTURAL_SCORE_INELIGIBLE_WARNING_CODES = [
  ...LIVE_RESERVE_STRUCTURAL_DEGRADED_WARNING_CODES,
  "self-referential-reserve",
  "undercollateralized",
  "usdai-composition-unverified",
] as const;
