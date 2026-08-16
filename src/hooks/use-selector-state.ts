"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import {
  decodeSelectorState,
  encodeSelectorState,
  highestValidStep,
  SELECTOR_URL_KEYS,
  transition,
  type SelectorAction,
  type SelectorStep,
  type SelectorWizardState,
} from "@/lib/selector-state";

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
  const rehydratedRef = useRef(false);

  useEffect(() => {
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    const valid = highestValidStep(state);
    const urlStep = state.step;
    const urlClaimsBeyondValid =
      (urlStep === "result" && valid !== "result") ||
      (typeof urlStep === "number" && typeof valid === "number" && urlStep > valid);
    if (urlClaimsBeyondValid) {
      const next = { ...state, step: valid };
      replaceParams((params) => {
        for (const key of SELECTOR_URL_KEYS) params.delete(key);
        const fresh = encodeSelectorState(next);
        for (const [key, value] of fresh) params.set(key, value);
      });
    }
  }, [state, replaceParams]);

  const dispatch = useCallback((action: SelectorAction) => {
    const next = transition(state, action);
    const updater = (params: URLSearchParams) => {
      for (const key of SELECTOR_URL_KEYS) params.delete(key);
      const fresh = encodeSelectorState(next);
      for (const [key, value] of fresh) params.set(key, value);
    };
    if (action.type === "relax" || action.type === "go-back") {
      replaceParams(updater);
    } else {
      pushSearchParams(updater);
    }
  }, [state, pushSearchParams, replaceParams]);

  const setStep = useCallback((step: SelectorStep) => {
    const next = { ...state, step };
    pushSearchParams((params) => {
      for (const key of SELECTOR_URL_KEYS) params.delete(key);
      const fresh = encodeSelectorState(next);
      for (const [key, value] of fresh) params.set(key, value);
    });
  }, [state, pushSearchParams]);

  const toSearchString = useCallback(() => encodeSelectorState(state).toString(), [state]);
  return { state, dispatch, setStep, toSearchString };
}
