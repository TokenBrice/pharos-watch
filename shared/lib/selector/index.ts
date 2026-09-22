/**
 * Public surface of the Stablecoin Picker.
 *
 * Keep this barrel limited to symbols consumed outside the Selector module.
 * Internal code and tests import implementation modules directly.
 */
export {
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  isSelectorEligiblePegCurrency,
  type SelectorComponent,
  type SelectorEligiblePegCurrency,
  type SelectorInput,
  type SelectorLowerRanked,
  type SelectorOutput,
  type SelectorProfile,
  type SelectorRecommendation,
  type SelectorScreenerFilterProjection,
  type SkippedCoin,
} from "./types";
export { runSelector } from "./engine";
export {
  buildScreenerUrl,
  selectorAnswersToScreenerFilters,
} from "./answers-to-screener";
export { getTemplate } from "./what-to-watch-templates";
export { validateSelectorSnapshotResponse } from "./snapshot";
