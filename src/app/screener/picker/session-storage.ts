import type { SelectorOutput } from "@shared/lib/selector";
import {
  getWindowStorage,
  readJsonStorageValue,
  safeStorageRemoveItem,
  writeJsonStorageValue,
} from "@/lib/browser-storage";
import {
  highestValidStep,
  SELECTOR_STATE_DEFAULTS,
  type SelectorStep,
  type SelectorWizardState,
} from "@/lib/selector-state";
import { venueFromInput } from "@/lib/selector-handoff";

const SESSION_RESULT_STORAGE_KEY = "pharos.selector.sessionResult.v1";

export interface StoredSelectorRun {
  state: SelectorWizardState;
  output: SelectorOutput;
  savedAt: number;
}

function decodeStoredSelectorRun(value: unknown): StoredSelectorRun | null {
  const parsed = value as Partial<StoredSelectorRun>;
  if (!parsed.state || !parsed.output || typeof parsed.savedAt !== "number") return null;
  const state = parsed.state;
  if (state.step !== "result" || highestValidStep(state) !== "result") return null;
  return {
    state: { ...state, sid: null, ev: null },
    output: parsed.output,
    savedAt: parsed.savedAt,
  };
}

export function writeStoredSelectorRun(state: SelectorWizardState, output: SelectorOutput): void {
  const storedState = { ...state, step: "result" as const, sid: null, ev: null };
  const payload: StoredSelectorRun = {
    state: storedState,
    output,
    savedAt: Date.now(),
  };
  writeJsonStorageValue(getWindowStorage("session"), SESSION_RESULT_STORAGE_KEY, payload);
}

export function readStoredSelectorRun(): StoredSelectorRun | null {
  return readJsonStorageValue(
    getWindowStorage("session"),
    SESSION_RESULT_STORAGE_KEY,
    decodeStoredSelectorRun,
    null,
    clearStoredSelectorRun,
  );
}

export function clearStoredSelectorRun(): void {
  safeStorageRemoveItem(getWindowStorage("session"), SESSION_RESULT_STORAGE_KEY);
}

export function wizardStateFromOutput(
  output: SelectorOutput,
  fallbackState: SelectorWizardState,
  step: SelectorStep,
): SelectorWizardState {
  const input = output.input;
  const fallbackMatchesInput =
    fallbackState.profile === input.profile &&
    fallbackState.pegCurrency === input.pegCurrency &&
    fallbackState.horizon === input.horizon &&
    fallbackState.depegTolerance === input.depegTolerance &&
    fallbackState.venue.length > 0;
  return {
    profile: input.profile,
    pegCurrency: input.pegCurrency,
    horizon: input.horizon,
    depegTolerance: input.depegTolerance,
    venue: fallbackMatchesInput ? fallbackState.venue : venueFromInput(input),
    exitSpeed: input.exitSpeed,
    step,
    sid: null,
    ev: null,
  };
}

export function isInitialSelectorState(state: SelectorWizardState): boolean {
  return (
    state.profile == null &&
    state.pegCurrency === SELECTOR_STATE_DEFAULTS.pegCurrency &&
    state.horizon == null &&
    state.depegTolerance == null &&
    state.venue.length === 0 &&
    state.exitSpeed == null &&
    state.step === 1 &&
    state.sid == null
  );
}
