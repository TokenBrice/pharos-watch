"use client";

import { useCallback, useEffect, useState } from "react";
import {
  evaluateHomepageStartHereCallout,
  markStartHereOpened,
  readStartHereCalloutState,
  START_HERE_CALLOUT_SESSION_KEY,
  writeStartHereCalloutState,
} from "@/lib/start-here-callout";

export function useStartHereCallout() {
  const [shouldShow, setShouldShow] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const state = readStartHereCalloutState(window.localStorage);
      const hasSeenCurrentSession = window.sessionStorage.getItem(START_HERE_CALLOUT_SESSION_KEY) === "true";
      const evaluation = evaluateHomepageStartHereCallout(state, hasSeenCurrentSession);

      if (evaluation.shouldPersist) {
        writeStartHereCalloutState(window.localStorage, evaluation.nextState);
        window.sessionStorage.setItem(START_HERE_CALLOUT_SESSION_KEY, "true");
      }

      setShouldShow(evaluation.shouldShow);
    } catch {
      setShouldShow(true);
    } finally {
      setIsReady(true);
    }
  }, []);

  const retireCallout = useCallback(() => {
    if (typeof window !== "undefined") {
      try {
        const nextState = markStartHereOpened(readStartHereCalloutState(window.localStorage));
        writeStartHereCalloutState(window.localStorage, nextState);
      } catch {
        // Ignore unavailable storage and still hide for the current render.
      }
    }

    setShouldShow(false);
  }, []);

  return {
    isReady,
    shouldShow,
    retireCallout,
  };
}
