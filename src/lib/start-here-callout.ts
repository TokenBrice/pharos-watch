import { readJsonStorageValue, writeJsonStorageValue } from "@/lib/browser-storage";

export interface StartHereCalloutState {
  homepageSessions: number;
  hasOpenedStartHere: boolean;
}

const START_HERE_CALLOUT_STORAGE_KEY = "pharos-start-here-callout";
const MAX_START_HERE_HOMEPAGE_SESSIONS = 1;

const DEFAULT_STATE: StartHereCalloutState = {
  homepageSessions: 0,
  hasOpenedStartHere: false,
};

export function normalizeStartHereCalloutState(value: unknown): StartHereCalloutState {
  if (!value || typeof value !== "object") return DEFAULT_STATE;

  const candidate = value as Partial<StartHereCalloutState>;
  const homepageSessions =
    typeof candidate.homepageSessions === "number" && Number.isFinite(candidate.homepageSessions)
      ? Math.max(0, Math.floor(candidate.homepageSessions))
      : 0;

  return {
    homepageSessions,
    hasOpenedStartHere: candidate.hasOpenedStartHere === true,
  };
}

export function readStartHereCalloutState(storage: Storage): StartHereCalloutState {
  return readJsonStorageValue(storage, START_HERE_CALLOUT_STORAGE_KEY, normalizeStartHereCalloutState, DEFAULT_STATE);
}

function writeStartHereCalloutState(storage: Storage, state: StartHereCalloutState): void {
  writeJsonStorageValue(storage, START_HERE_CALLOUT_STORAGE_KEY, state);
}

export function shouldShowStartHereNavigation(state: StartHereCalloutState): boolean {
  return !state.hasOpenedStartHere && state.homepageSessions <= MAX_START_HERE_HOMEPAGE_SESSIONS;
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
  writeStartHereCalloutState(storage, nextState);
}
