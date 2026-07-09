/**
 * Public surface of the Stablecoin Picker engine.
 *
 * Frontend imports `runSelector`, `selectorAnswersToScreenerFilters`,
 * `computeSnapshotId`, and the types from this barrel. Engine-internal
 * shapes (`MergedRow`, `SelectorData`, `DatasetMetadata`) are exported but
 * documented `@internal`.
 */

export * from "./types";
export { SELECTOR_VERSION } from "./version";
export {
  WEIGHTS_VERSION,
  WEIGHT_VECTORS,
  assertWeightsSumTo100,
  getWeightVectorForInput,
} from "./weights";
export { whyKeysByProfile, WHY_KEYS, WHY_KEYS_SET } from "./why-keys";
export {
  HOWEY_UNCERTAIN_ASSETS,
  PROFILE_DEFINING_EXCLUSIONS,
  REQUIRED_SIGNALS_BY_PROFILE,
  activeDepegThresholdBps,
  applyInputDrivenExclusions,
  applyProfileExclusions,
  applyUniversalExclusions,
  evaluateExclusions,
  hasRequiredSignals,
  tradingDewsCeiling,
} from "./exclusions";
export {
  bluechip,
  excessApyConcave,
  hhiToDiversity,
  identity,
  invert100,
  pegYieldScore,
  sourceRiskInverted,
  supplyLog,
  yieldVariance,
} from "./normalization";
export {
  LOWEST_SUB_DIMENSION_CANDIDATES,
  lookupNormalizedSubDimension,
  selectLowestSubDimension,
} from "./lowest-sub-dimension";
export { selectLowerRanked, userEmphasizedDimension } from "./lower-ranked";
export { ENGINE_VERSION, mergeRow, runSelector, scoreIgnoringExclusion } from "./engine";
export {
  buildScreenerUrl,
  selectorAnswersToScreenerFilters,
} from "./answers-to-screener";
export {
  TEMPLATES as WHAT_TO_WATCH_TEMPLATES,
  getTemplate,
  getLowerRankedText,
  labelForSelectorReason,
  type WhatToWatchTemplate,
} from "./what-to-watch-templates";
export {
  canonicalizeForDatasetHash,
  canonicalizeForSid,
} from "./canonicalize";
export {
  SELECTOR_SNAPSHOT_MAX_PAYLOAD_BYTES,
  SELECTOR_SNAPSHOT_SID_PATTERN,
  SELECTOR_SNAPSHOT_TTL_SECONDS,
  computeSelectorSnapshotSid,
  createVerifiedSelectorSnapshot,
  isSelectorSnapshotSid,
  isSelectorSnapshotStructurallySafe,
  stripDebugFromSelectorSnapshot,
  validateSelectorSnapshot,
  validateSelectorSnapshotInput,
  validateSelectorSnapshotResponse,
  validateVerifiedSelectorSnapshot,
  type SelectorSnapshotInputValidationResult,
  type SelectorSnapshotValidationError,
  type SelectorSnapshotValidationResult,
} from "./snapshot";
