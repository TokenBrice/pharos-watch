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
