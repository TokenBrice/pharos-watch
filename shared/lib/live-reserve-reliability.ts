/**
 * Degraded-warning codes that a live-reserve adapter emits deliberately, by
 * construction — a structural/economic finding, not an operational failure.
 * A degraded attempt whose only degraded-effect
 * warnings are in this list counts as `degradedByDesign` in the 30-day adapter
 * reliability rollup, and therefore toward its `successRate`.
 *
 * The completed post-sync observer also uses this authority to keep structural
 * score-ineligibility in quality metadata. Sync status, scoring admission,
 * warning allowlists, source clocks and feed reviews remain independent.
 */
export const LIVE_RESERVE_STRUCTURAL_DEGRADED_WARNING_CODES = [
  // chainlink-nav / chronicle-nav `navScope: "portfolio"`: the NAV values the
  // portfolio but never verifies its composition.
  "nav-portfolio-composition-unverified",
  "self-referential-reserve",
  "undercollateralized",
  "usdai-composition-unverified",
] as const;
