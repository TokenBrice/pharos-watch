import { readJsonStorageValue, writeJsonStorageValue } from "@/lib/browser-storage";

export interface StartHereCalloutState {
  hasOpenedStartHere: boolean;
}

const START_HERE_CALLOUT_STORAGE_KEY = "pharos-start-here-callout";

const DEFAULT_STATE: StartHereCalloutState = {
  hasOpenedStartHere: false,
};

// Browsers that stored the pre-cleanup shape still carry a `homepageSessions`
// counter; it is ignored here and dropped on the next write.
export function normalizeStartHereCalloutState(value: unknown): StartHereCalloutState {
  if (!value || typeof value !== "object") return DEFAULT_STATE;

  const candidate = value as Partial<StartHereCalloutState>;
  return { hasOpenedStartHere: candidate.hasOpenedStartHere === true };
}

export function readStartHereCalloutState(storage: Storage): StartHereCalloutState {
  return readJsonStorageValue(storage, START_HERE_CALLOUT_STORAGE_KEY, normalizeStartHereCalloutState, DEFAULT_STATE);
}

export function shouldShowStartHereNavigation(state: StartHereCalloutState): boolean {
  return !state.hasOpenedStartHere;
}

export function markStartHereOpened(state: StartHereCalloutState): StartHereCalloutState {
  if (state.hasOpenedStartHere) return state;
  return {
    ...state,
    hasOpenedStartHere: true,
  };
}

export function persistStartHereOpened(storage: Storage): void {
  const nextState = markStartHereOpened(readStartHereCalloutState(storage));
  writeJsonStorageValue(storage, START_HERE_CALLOUT_STORAGE_KEY, nextState);
}
