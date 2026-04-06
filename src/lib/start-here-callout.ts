export interface StartHereCalloutState {
  homepageSessions: number;
  hasOpenedStartHere: boolean;
}

export interface HomepageStartHereCalloutEvaluation {
  nextState: StartHereCalloutState;
  shouldPersist: boolean;
  shouldShow: boolean;
}

export const START_HERE_CALLOUT_STORAGE_KEY = "pharos-start-here-callout";
export const START_HERE_CALLOUT_SESSION_KEY = "pharos-start-here-callout-session";
export const MAX_START_HERE_HOMEPAGE_SESSIONS = 1;

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
  const stored = storage.getItem(START_HERE_CALLOUT_STORAGE_KEY);
  if (!stored) return DEFAULT_STATE;

  try {
    return normalizeStartHereCalloutState(JSON.parse(stored));
  } catch {
    return DEFAULT_STATE;
  }
}

export function writeStartHereCalloutState(storage: Storage, state: StartHereCalloutState): void {
  storage.setItem(START_HERE_CALLOUT_STORAGE_KEY, JSON.stringify(state));
}

export function evaluateHomepageStartHereCallout(
  state: StartHereCalloutState,
  hasSeenCurrentSession: boolean,
): HomepageStartHereCalloutEvaluation {
  const nextState = hasSeenCurrentSession
    ? state
    : {
        ...state,
        homepageSessions: state.homepageSessions + 1,
      };

  return {
    nextState,
    shouldPersist: !hasSeenCurrentSession,
    shouldShow: shouldShowStartHereNavigation(nextState),
  };
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
