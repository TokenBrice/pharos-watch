import type { ResourcePressure } from "@shared/types/status/cron";
import { buildResourcePressure } from "../cron-resource-pressure";
import { REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES } from "../report-cards-fixed-input-cache-codec";

// Reviewed full catalog and active publication cardinalities. Never truncate a
// catalog or card inventory to satisfy these admission limits.
const SAFETY_SCORE_V9_CATALOG_MAX_ASSETS = 488;
const SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS = 397;

export function assessSafetyScoreV9ResourceBudget(input: {
  catalogAssets: number;
  activeAssets: number;
  inputBytes: number | null;
}): {
  admitted: boolean;
  reason: "resource-budget-exceeded" | null;
  resourcePressure: ResourcePressure;
} {
  const admitted = Number.isSafeInteger(input.catalogAssets) && input.catalogAssets >= 0 &&
    input.catalogAssets <= SAFETY_SCORE_V9_CATALOG_MAX_ASSETS &&
    Number.isSafeInteger(input.activeAssets) && input.activeAssets >= 0 &&
    input.activeAssets <= SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS &&
    (input.inputBytes === null || (Number.isSafeInteger(input.inputBytes) && input.inputBytes >= 0 &&
      input.inputBytes <= REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES));
  return {
    admitted,
    reason: admitted ? null : "resource-budget-exceeded",
    resourcePressure: buildResourcePressure({
      phase: "compile-admission",
      inputCapBytes: REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES,
      catalogMaxAssets: SAFETY_SCORE_V9_CATALOG_MAX_ASSETS,
      inputBytes: input.inputBytes,
      catalogAssets: input.catalogAssets,
      guard: admitted ? "within-policy" : "resource-budget-exceeded",
    }),
  };
}
