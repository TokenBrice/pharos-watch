import type { IndependentAssuranceProduct, IndependentAssuranceReconciliationOptions } from "./independent-assurance";

export const ASSURANCE_RECONCILIATION_TOLERANCES: Partial<Record<IndependentAssuranceProduct, IndependentAssuranceReconciliationOptions>> = {
  AUDD: {
    // Nine cent-rounded chain rows plus a cent-rounded total: 10 * 0.005 AUD.
    // Preserve independently printed values and expose reconciliation differences.
    reportedLiabilityTotalTolerance: { absolute: "0.05", relativePpm: 0.01 },
  },
  AUSD: {
    // August 2026 categories sum to $239,090,455; the printed total is $239,090,456.
    reportedAssetTotalTolerance: { absolute: "1", relativePpm: 1 },
  },
  EUROP: {
    reportedAssetTotalTolerance: { absolute: "1", relativePpm: 1 },
    reportedLiabilityTotalTolerance: { absolute: "1", relativePpm: 1 },
  },
  MYRC: {
    // August 2026 cash/fund schedule exceeds the asserted account total by MYR 0.03.
    reportedAssetTotalTolerance: { absolute: "0.03", relativePpm: 0.02 },
  },
};
