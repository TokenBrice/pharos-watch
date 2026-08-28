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
  type SelectorWizardState,
} from "@/lib/selector-state";

export interface UseSelectorStateResult {
  state: SelectorWizardState;
  dispatch: (action: SelectorAction) => void;
}

function writeSelectorState(params: URLSearchParams, state: SelectorWizardState): void {
  for (const key of SELECTOR_URL_KEYS) params.delete(key);
  const fresh = encodeSelectorState(state);
  for (const [key, value] of fresh) params.set(key, value);
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
      replaceParams((params) => writeSelectorState(params, next));
    }
  }, [state, replaceParams]);

  const dispatch = useCallback((action: SelectorAction) => {
    const next = transition(state, action);
    const updater = (params: URLSearchParams) => writeSelectorState(params, next);
    if (action.type === "relax" || action.type === "go-back") {
      replaceParams(updater);
    } else {
      pushSearchParams(updater);
    }
  }, [state, pushSearchParams, replaceParams]);

  return { state, dispatch };
}
