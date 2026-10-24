import treatmentIds from "./stablecoin-title-cohort.json";

/**
 * Active-profile `<title>` cohort (SEO plan W2.1, started 2026-10-25).
 *
 * Treatment = every second id (1-based positions 2, 4, 6, …) of
 * `shared/data/stablecoins/canonical-order.json` as of commit a23e4ced8. The
 * list is frozen in `stablecoin-title-cohort.json` so later catalog insertions
 * or reorders cannot reshuffle the arms mid-test; ids added afterwards are
 * control. See `docs/stablecoin-detail-page.md#metadata`.
 *
 * Adopt the treatment sitewide with `"treatment"`, revert with `"control"`.
 */
const STABLECOIN_TITLE_COHORT_MODE = "split" as "split" | "treatment" | "control";

const TREATMENT_IDS: ReadonlySet<string> = new Set(treatmentIds);

export function isStablecoinTitleTreatment(stablecoinId: string): boolean {
  if (STABLECOIN_TITLE_COHORT_MODE === "treatment") return true;
  if (STABLECOIN_TITLE_COHORT_MODE === "control") return false;
  return TREATMENT_IDS.has(stablecoinId);
}
