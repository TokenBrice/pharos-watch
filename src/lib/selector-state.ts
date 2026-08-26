/**
 * URL state codec + pure wizard state machine for `/screener/picker/`.
 *
 * Flat URL keys per plan §2.1: `p` `peg` `h` `d` `v` `u` `step` + share-link `sid` `ev`.
 * The codec encodes only non-default fields; null is expressed as a missing key.
 *
 * The transition function is pure. The URL-backed React adapter lives in
 * `src/hooks/use-selector-state.ts`.
 */

import {
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  isSelectorEligiblePegCurrency,
  type SelectorEligiblePegCurrency,
  type SelectorInput,
} from "@shared/lib/selector";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

const SELECTOR_PROFILE_VALUES = ["treasury", "yield", "trading"] as const;
export type SelectorProfile = (typeof SELECTOR_PROFILE_VALUES)[number];

export type SelectorPeg = SelectorEligiblePegCurrency;

const SELECTOR_HORIZON_VALUES = [
  "lt24h", "1to7d", "1to4w", "1to6m", "6mplus",
] as const;
export type SelectorHorizon = (typeof SELECTOR_HORIZON_VALUES)[number];

const SELECTOR_DEPEG_VALUES = ["zero", "tight", "moderate"] as const;
export type SelectorDepeg = (typeof SELECTOR_DEPEG_VALUES)[number];

const SELECTOR_EXIT_VALUES = ["1h", "24h", "any"] as const;
export type SelectorExit = (typeof SELECTOR_EXIT_VALUES)[number];

// Venue values vary by profile but share a single set so the URL codec is flat.
const SELECTOR_VENUE_VALUES = [
  // Yield
  "lend", "dex", "wrap",
  // Trading
  "cex", "perps", "spot",
  // Treasury (single-select uses these values)
  "custody", "some", "active",
  // Shared "All of the above" sentinel
  "all",
] as const;
export type SelectorVenue = (typeof SELECTOR_VENUE_VALUES)[number];

const SELECTOR_VENUES_BY_PROFILE: Record<SelectorProfile, readonly SelectorVenue[]> = {
  treasury: ["custody", "some", "active"],
  yield: ["lend", "dex", "wrap", "all"],
  trading: ["cex", "perps", "spot", "all"],
};

export type SelectorStep = 1 | 2 | 3 | 4 | 5 | 6 | "result";

// ---------------------------------------------------------------------------
// Wizard state shape
// ---------------------------------------------------------------------------

export interface SelectorWizardState {
  profile: SelectorProfile | null;
  pegCurrency: SelectorPeg;
  horizon: SelectorHorizon | null;
  depegTolerance: SelectorDepeg | null;
  venue: readonly SelectorVenue[];
  exitSpeed: SelectorExit | null;
  step: SelectorStep;
  sid: string | null;
  ev: string | null;
}

export const SELECTOR_STATE_DEFAULTS: SelectorWizardState = {
  profile: null,
  pegCurrency: "USD",
  horizon: null,
  depegTolerance: null,
  venue: [],
  exitSpeed: null,
  step: 1,
  sid: null,
  ev: null,
};

// ---------------------------------------------------------------------------
// Codec — pure
// ---------------------------------------------------------------------------

function decodeEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | null {
  if (!raw) return null;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

function decodeEnumList<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): readonly T[] {
  if (!raw) return [];
  const out: T[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (trimmed === "") continue;
    if ((allowed as readonly string[]).includes(trimmed) && !out.includes(trimmed as T)) {
      out.push(trimmed as T);
    }
  }
  return out;
}

function decodeStep(raw: string | null): SelectorStep {
  if (!raw) return 1;
  if (raw === "result") return "result";
  const n = Number.parseInt(raw, 10);
  if (n >= 1 && n <= 6) return n as 1 | 2 | 3 | 4 | 5 | 6;
  return 1;
}

function decodeString(raw: string | null): string | null {
  if (raw == null || raw === "") return null;
  return raw;
}

const SELECTOR_SNAPSHOT_ID_PATTERN = /^[a-f0-9]{32}$/i;

export function isValidSelectorSnapshotId(raw: string | null): raw is string {
  return raw != null && SELECTOR_SNAPSHOT_ID_PATTERN.test(raw.trim());
}

function decodeSnapshotId(raw: string | null): string | null {
  if (raw == null || raw.trim() === "") return null;
  return raw.trim().toLowerCase();
}

export function decodeSelectorState(search: string | URLSearchParams): SelectorWizardState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const profile = decodeEnum(params.get("p"), SELECTOR_PROFILE_VALUES);
  const requestedPeg =
    decodeEnum(params.get("peg"), SELECTOR_ELIGIBLE_PEG_CURRENCIES) ?? "USD";
  const pegCurrency = normalizePegForProfile(profile, requestedPeg);
  const decodedVenue = decodeEnumList(params.get("v"), SELECTOR_VENUE_VALUES);
  const venue = profile ? pruneVenueForProfile(profile, decodedVenue) : [];
  return {
    profile,
    pegCurrency,
    horizon: decodeEnum(params.get("h"), SELECTOR_HORIZON_VALUES),
    depegTolerance: decodeEnum(params.get("d"), SELECTOR_DEPEG_VALUES),
    venue,
    exitSpeed: decodeEnum(params.get("u"), SELECTOR_EXIT_VALUES),
    step: decodeStep(params.get("step")),
    sid: decodeSnapshotId(params.get("sid")),
    ev: decodeString(params.get("ev")),
  };
}

export function encodeSelectorState(state: SelectorWizardState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.profile) params.set("p", state.profile);
  if (state.pegCurrency !== "USD") params.set("peg", state.pegCurrency);
  if (state.horizon) params.set("h", state.horizon);
  if (state.depegTolerance) params.set("d", state.depegTolerance);
  if (state.venue.length > 0) params.set("v", state.venue.join(","));
  if (state.exitSpeed) params.set("u", state.exitSpeed);
  if (state.step !== 1) {
    params.set("step", state.step === "result" ? "result" : String(state.step));
  }
  if (state.sid) params.set("sid", state.sid);
  if (state.ev) params.set("ev", state.ev);
  return params;
}

// All Selector-owned URL keys; useful for clearing prior state without
// touching unrelated query params.
export const SELECTOR_URL_KEYS = ["p", "peg", "h", "d", "v", "u", "step", "sid", "ev"] as const;

// ---------------------------------------------------------------------------
// Step pre-conditions and `highestValidStep` (plan §2.4)
// ---------------------------------------------------------------------------

export function shouldSkipExitStep(
  profile: SelectorProfile | null,
  horizon: SelectorHorizon | null,
  depeg: SelectorDepeg | null,
): boolean {
  return profile === "treasury" && horizon === "6mplus" && depeg === "zero";
}

function pruneVenueForProfile(
  profile: SelectorProfile,
  venue: readonly SelectorVenue[],
): readonly SelectorVenue[] {
  const allowed = SELECTOR_VENUES_BY_PROFILE[profile];
  const filtered = venue.filter((value) => allowed.includes(value));
  if (filtered.includes("all")) return ["all"];
  if (profile === "treasury") return filtered.slice(0, 1);
  return filtered;
}

function normalizePegForProfile(
  profile: SelectorProfile | null,
  pegCurrency: SelectorPeg,
): SelectorPeg {
  if (profile === "yield" && !isSelectorEligiblePegCurrency(pegCurrency)) {
    return "USD";
  }
  return pegCurrency;
}

function hasValidVenue(state: SelectorWizardState): boolean {
  return state.profile != null && pruneVenueForProfile(state.profile, state.venue).length > 0;
}

const PREVIOUS_STEP_BY_STEP: Record<Exclude<SelectorStep, "result">, SelectorStep> = {
  1: 1,
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
};

export function highestValidStep(state: SelectorWizardState): SelectorStep {
  if (!state.profile) return 1;
  if (!state.horizon) return 3;
  if (!state.depegTolerance) return 4;
  if (!hasValidVenue(state)) return 5;
  if (shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance)) {
    return "result";
  }
  if (!state.exitSpeed) return 6;
  return "result";
}

// ---------------------------------------------------------------------------
// Pure transition (plan §2.3)
// ---------------------------------------------------------------------------

export type SelectorAction =
  | { type: "set-profile"; value: SelectorProfile }
  | { type: "answer-profile"; value: SelectorProfile }
  | { type: "set-peg"; value: SelectorPeg }
  | { type: "answer-peg"; value: SelectorPeg }
  | { type: "set-horizon"; value: SelectorHorizon }
  | { type: "answer-horizon"; value: SelectorHorizon }
  | { type: "set-depeg"; value: SelectorDepeg }
  | { type: "answer-depeg"; value: SelectorDepeg }
  // `set-venue` updates the venue selection without advancing the step;
  // used by multi-select venue (Yield, Active Trading) so each checkbox toggle
  // does not jump to exit. `answer-venue` is the explicit "Next" commit.
  | { type: "set-venue"; value: readonly SelectorVenue[] }
  | { type: "answer-venue"; value: readonly SelectorVenue[] }
  | { type: "set-exit"; value: SelectorExit }
  | { type: "answer-exit"; value: SelectorExit }
  | { type: "advance-to-result" } // mobile single-form submit
  | { type: "restore-session"; state: SelectorWizardState }
  | { type: "start-over" }
  | { type: "go-back" }
  | { type: "adjust" }
  | { type: "relax"; constraint: "depegTolerance" | "venue" | "exitSpeed" };

export function transition(
  state: SelectorWizardState,
  action: SelectorAction,
): SelectorWizardState {
  const withoutSnapshot = { ...state, sid: null, ev: null };
  switch (action.type) {
    case "set-profile":
      return {
        ...withoutSnapshot,
        profile: action.value,
        pegCurrency: normalizePegForProfile(action.value, state.pegCurrency),
        horizon: null,
        depegTolerance: null,
        venue: [],
        exitSpeed: null,
        step: 1,
      };
    case "answer-profile":
      return {
        ...withoutSnapshot,
        profile: action.value,
        pegCurrency: normalizePegForProfile(action.value, state.pegCurrency),
        horizon: null,
        depegTolerance: null,
        venue: [],
        exitSpeed: null,
        step: 2,
      };
    case "set-peg":
      return {
        ...withoutSnapshot,
        pegCurrency: normalizePegForProfile(state.profile, action.value),
      };
    case "answer-peg":
      return {
        ...withoutSnapshot,
        pegCurrency: normalizePegForProfile(state.profile, action.value),
        step: 3,
      };
    case "set-horizon":
      return { ...withoutSnapshot, horizon: action.value };
    case "answer-horizon":
      return { ...withoutSnapshot, horizon: action.value, step: 4 };
    case "set-depeg":
      return { ...withoutSnapshot, depegTolerance: action.value };
    case "answer-depeg":
      return { ...withoutSnapshot, depegTolerance: action.value, step: 5 };
    case "set-venue":
      return {
        ...withoutSnapshot,
        venue: state.profile ? pruneVenueForProfile(state.profile, action.value) : [],
      };
    case "answer-venue": {
      const venue = state.profile ? pruneVenueForProfile(state.profile, action.value) : [];
      if (shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance)) {
        return { ...withoutSnapshot, venue, exitSpeed: "any", step: "result" };
      }
      return { ...withoutSnapshot, venue, step: 6 };
    }
    case "set-exit":
      return { ...withoutSnapshot, exitSpeed: action.value };
    case "answer-exit":
      return { ...withoutSnapshot, exitSpeed: action.value, step: "result" };
    case "advance-to-result":
      return { ...withoutSnapshot, step: "result" };
    case "restore-session":
      return { ...action.state, sid: null, ev: null };
    case "start-over":
      return SELECTOR_STATE_DEFAULTS;
    case "go-back":
      return { ...state, step: previousStep(state) };
    case "adjust":
      return { ...withoutSnapshot, step: 1 };
    case "relax": {
      const next = { ...withoutSnapshot };
      if (action.constraint === "depegTolerance" && state.depegTolerance === "zero") {
        next.depegTolerance = "tight";
      } else if (action.constraint === "depegTolerance" && state.depegTolerance === "tight") {
        next.depegTolerance = "moderate";
      } else if (action.constraint === "venue") {
        next.venue = ["all"];
      } else if (action.constraint === "exitSpeed") {
        next.exitSpeed = "any";
      }
      return next;
    }
  }
}

function previousStep(state: SelectorWizardState): SelectorStep {
  if (state.step === "result") {
    return shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance) ? 5 : 6;
  }
  return PREVIOUS_STEP_BY_STEP[state.step];
}

// ---------------------------------------------------------------------------
// Selector input adapter
// ---------------------------------------------------------------------------

export function toSelectorInput(state: SelectorWizardState): SelectorInput | null {
  if (
    !state.profile ||
    (state.profile === "yield" && !isSelectorEligiblePegCurrency(state.pegCurrency)) ||
    !state.horizon ||
    !state.depegTolerance ||
    !hasValidVenue(state)
  ) {
    return null;
  }
  const exitSpeed = state.exitSpeed
    ?? (shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance) ? "any" : null);
  if (!exitSpeed) return null;

  return {
    profile: state.profile,
    pegCurrency: state.pegCurrency,
    horizon: state.horizon,
    depegTolerance: state.depegTolerance,
    composability: composabilityFromVenue(state.profile, state.venue),
    exitSpeed,
    venuePreferences: state.venue,
    minApy: null,
    yieldNativeOnly: false,
    decentralization: decentralizationFromVenue(state.profile, state.venue),
    custodyOk: custodyOkFromVenue(state.profile, state.venue),
  };
}

function composabilityFromVenue(
  profile: SelectorProfile,
  venue: readonly SelectorVenue[],
): "none" | "moderate" | "high" {
  // Mapping per design §3.7
  if (venue.includes("all")) return "high";
  if (profile === "treasury") {
    if (venue.includes("custody")) return "none";
    if (venue.includes("active")) return "high";
    if (venue.includes("some")) return "moderate";
    return "moderate";
  }
  // Yield + Trading: any single rail = moderate; 2+ = high
  return venue.length >= 2 ? "high" : "moderate";
}

function decentralizationFromVenue(
  profile: SelectorProfile,
  venue: readonly SelectorVenue[],
): SelectorInput["decentralization"] {
  if (profile === "treasury" && venue.includes("active")) return "required";
  return "any";
}

function custodyOkFromVenue(
  profile: SelectorProfile,
  venue: readonly SelectorVenue[],
): SelectorInput["custodyOk"] {
  if (profile === "treasury" && venue.includes("custody")) return "regulated-only";
  if (profile === "treasury" && venue.includes("active")) return "onchain-only";
  return "any";
}

// ---------------------------------------------------------------------------
// Pre-highlight (plan §2.5) — UI affordance only, not a state mutation
// ---------------------------------------------------------------------------

export function preHighlightForDepeg(
  profile: SelectorProfile | null,
  horizon: SelectorHorizon | null,
): SelectorDepeg | undefined {
  if (profile === "treasury" && horizon === "6mplus") return "zero";
  if (profile === "yield") return "tight";
  return undefined;
}

// ---------------------------------------------------------------------------
// Soft confirmation triggers (plan §2.6)
// ---------------------------------------------------------------------------

export function softConfirmationForHorizon(
  profile: SelectorProfile | null,
  horizon: SelectorHorizon | null,
): { message: string } | null {
  if (profile === "trading" && horizon === "6mplus") {
    return {
      message:
        "That's longer than most active traders hold — want to switch to Treasury constraints?",
    };
  }
  if (profile === "treasury" && horizon === "lt24h") {
    return {
      message:
        "Treasury is calibrated for longer holds — want to switch to Trade actively?",
    };
  }
  return null;
}
