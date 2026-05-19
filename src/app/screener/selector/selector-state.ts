/**
 * URL state codec + pure wizard state machine for `/screener/selector/`.
 *
 * Flat URL keys per plan §2.1: `p` `h` `d` `v` `u` `step` + share-link `sid` `ev`.
 * The codec encodes only non-default fields; null is expressed as a missing key.
 *
 * The transition() function is pure. `useSelectorState()` wraps it with
 * `useUrlFilters` so each step push lands as a new history entry.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import type { SelectorInput } from "@shared/lib/selector";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const SELECTOR_PROFILE_VALUES = ["treasury", "yield", "trading"] as const;
export type SelectorProfile = (typeof SELECTOR_PROFILE_VALUES)[number];

export const SELECTOR_HORIZON_VALUES = [
  "lt24h", "1to7d", "1to4w", "1to6m", "6mplus",
] as const;
export type SelectorHorizon = (typeof SELECTOR_HORIZON_VALUES)[number];

export const SELECTOR_DEPEG_VALUES = ["zero", "tight", "moderate"] as const;
export type SelectorDepeg = (typeof SELECTOR_DEPEG_VALUES)[number];

export const SELECTOR_EXIT_VALUES = ["1h", "24h", "any"] as const;
export type SelectorExit = (typeof SELECTOR_EXIT_VALUES)[number];

// Venue values vary by profile but share a single set so the URL codec is flat.
export const SELECTOR_VENUE_VALUES = [
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

export const SELECTOR_STEP_VALUES = ["1", "2", "3", "4", "5", "result"] as const;
export type SelectorStepRaw = (typeof SELECTOR_STEP_VALUES)[number];
export type SelectorStep = 1 | 2 | 3 | 4 | 5 | "result";

// ---------------------------------------------------------------------------
// Wizard state shape
// ---------------------------------------------------------------------------

export interface SelectorWizardState {
  profile: SelectorProfile | null;
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
  if (n >= 1 && n <= 5) return n as 1 | 2 | 3 | 4 | 5;
  return 1;
}

function decodeString(raw: string | null): string | null {
  if (raw == null || raw === "") return null;
  return raw;
}

export function decodeSelectorState(search: string | URLSearchParams): SelectorWizardState {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return {
    profile: decodeEnum(params.get("p"), SELECTOR_PROFILE_VALUES),
    horizon: decodeEnum(params.get("h"), SELECTOR_HORIZON_VALUES),
    depegTolerance: decodeEnum(params.get("d"), SELECTOR_DEPEG_VALUES),
    venue: decodeEnumList(params.get("v"), SELECTOR_VENUE_VALUES),
    exitSpeed: decodeEnum(params.get("u"), SELECTOR_EXIT_VALUES),
    step: decodeStep(params.get("step")),
    sid: decodeString(params.get("sid")),
    ev: decodeString(params.get("ev")),
  };
}

export function encodeSelectorState(state: SelectorWizardState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.profile) params.set("p", state.profile);
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
export const SELECTOR_URL_KEYS = ["p", "h", "d", "v", "u", "step", "sid", "ev"] as const;

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

export function highestValidStep(state: SelectorWizardState): SelectorStep {
  if (!state.profile) return 1;
  if (!state.horizon) return 2;
  if (!state.depegTolerance) return 3;
  if (state.venue.length === 0) return 4;
  if (shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance)) {
    return "result";
  }
  if (!state.exitSpeed) return 5;
  return "result";
}

// ---------------------------------------------------------------------------
// Pure transition (plan §2.3)
// ---------------------------------------------------------------------------

export type SelectorAction =
  | { type: "answer-profile"; value: SelectorProfile }
  | { type: "answer-horizon"; value: SelectorHorizon }
  | { type: "answer-depeg"; value: SelectorDepeg }
  // `set-venue` updates the venue selection without advancing the step;
  // used by multi-select Q4 (Yield, Active Trading) so each checkbox toggle
  // does not jump to Q5. `answer-venue` is the explicit "Next" commit.
  | { type: "set-venue"; value: readonly SelectorVenue[] }
  | { type: "answer-venue"; value: readonly SelectorVenue[] }
  | { type: "answer-exit"; value: SelectorExit }
  | { type: "advance-to-result" } // mobile single-form submit
  | { type: "go-back" }
  | { type: "adjust" }
  | { type: "relax"; constraint: "depegTolerance" | "venue" | "exitSpeed" };

export function transition(
  state: SelectorWizardState,
  action: SelectorAction,
): SelectorWizardState {
  switch (action.type) {
    case "answer-profile":
      return { ...state, profile: action.value, step: 2 };
    case "answer-horizon":
      return { ...state, horizon: action.value, step: 3 };
    case "answer-depeg":
      return { ...state, depegTolerance: action.value, step: 4 };
    case "set-venue":
      return { ...state, venue: action.value };
    case "answer-venue": {
      const venue = action.value;
      if (shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance)) {
        return { ...state, venue, exitSpeed: "any", step: "result" };
      }
      return { ...state, venue, step: 5 };
    }
    case "answer-exit":
      return { ...state, exitSpeed: action.value, step: "result" };
    case "advance-to-result":
      return { ...state, step: "result" };
    case "go-back":
      return { ...state, step: previousStep(state) };
    case "adjust":
      return { ...state, step: 1 };
    case "relax": {
      const next = { ...state };
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
  switch (state.step) {
    case 1:
      return 1;
    case 2:
      return 1;
    case 3:
      return 2;
    case 4:
      return 3;
    case 5:
      return 4;
    case "result":
      if (shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance)) {
        return 4;
      }
      return 5;
  }
}

// ---------------------------------------------------------------------------
// Selector input adapter
// ---------------------------------------------------------------------------

export function toSelectorInput(state: SelectorWizardState): SelectorInput | null {
  if (
    !state.profile ||
    !state.horizon ||
    !state.depegTolerance ||
    state.venue.length === 0
  ) {
    return null;
  }
  const exitSpeed = state.exitSpeed
    ?? (shouldSkipExitStep(state.profile, state.horizon, state.depegTolerance) ? "any" : null);
  if (!exitSpeed) return null;

  return {
    profile: state.profile,
    pegCurrency: "USD",
    horizon: state.horizon,
    depegTolerance: state.depegTolerance,
    composability: composabilityFromVenue(state.profile, state.venue),
    exitSpeed,
    minApy: null,
    yieldNativeOnly: false,
    decentralization: "any",
    custodyOk: "any",
  };
}

export function composabilityFromVenue(
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
        "That's longer than most active traders hold — want to switch to Hold safely?",
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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSelectorStateResult {
  state: SelectorWizardState;
  dispatch: (action: SelectorAction) => void;
  setStep: (step: SelectorStep) => void;
  /** Build the canonical URL for the current state (no leading slash). */
  toSearchString: () => string;
}

export function useSelectorState(): UseSelectorStateResult {
  const { searchParams, pushSearchParams, replaceParams } = useUrlFilters();

  const state = useMemo(() => decodeSelectorState(searchParams), [searchParams]);

  // Rehydrate-down: if the URL claims a step beyond what's answerable, replace
  // step with the highest valid step on initial mount.
  const rehydratedRef = useRef(false);
  useEffect(() => {
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    const valid = highestValidStep(state);
    const urlStep = state.step;
    const urlClaimsBeyondValid =
      (urlStep === "result" && valid !== "result") ||
      (typeof urlStep === "number" && typeof valid === "number" && urlStep > valid) ||
      (typeof urlStep === "number" && valid === "result" && urlStep < 5 && false); // rehydrate-up not needed
    if (urlClaimsBeyondValid) {
      const next = { ...state, step: valid };
      replaceParams((params) => {
        for (const key of SELECTOR_URL_KEYS) params.delete(key);
        const fresh = encodeSelectorState(next);
        for (const [k, v] of fresh) params.set(k, v);
      });
    }
  }, [state, replaceParams]);

  const dispatch = useCallback(
    (action: SelectorAction) => {
      const next = transition(state, action);
      const isRelax = action.type === "relax";
      const updater = (params: URLSearchParams) => {
        for (const key of SELECTOR_URL_KEYS) params.delete(key);
        const fresh = encodeSelectorState(next);
        for (const [k, v] of fresh) params.set(k, v);
      };
      if (isRelax) {
        replaceParams(updater);
      } else {
        pushSearchParams(updater);
      }
    },
    [state, pushSearchParams, replaceParams],
  );

  const setStep = useCallback(
    (step: SelectorStep) => {
      const next = { ...state, step };
      pushSearchParams((params) => {
        for (const key of SELECTOR_URL_KEYS) params.delete(key);
        const fresh = encodeSelectorState(next);
        for (const [k, v] of fresh) params.set(k, v);
      });
    },
    [state, pushSearchParams],
  );

  const toSearchString = useCallback(
    () => encodeSelectorState(state).toString(),
    [state],
  );

  return { state, dispatch, setStep, toSearchString };
}
