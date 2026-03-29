"use client";

import { useCallback, useEffect, useState } from "react";
import {
  evaluateHomepageStartHereCallout,
  persistStartHereOpened,
  readStartHereCalloutState,
  START_HERE_CALLOUT_SESSION_KEY,
  writeStartHereCalloutState,
} from "@/lib/start-here-callout";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";

export function useStartHereCallout() {
  const [shouldShow, setShouldShow] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const localStorageRef = getWindowStorage("local");
    const sessionStorageRef = getWindowStorage("session");
    if (!localStorageRef || !sessionStorageRef) {
      setShouldShow(true);
      setIsReady(true);
      return;
    }

    try {
      const state = readStartHereCalloutState(localStorageRef);
      const hasSeenCurrentSession = safeStorageGetItem(sessionStorageRef, START_HERE_CALLOUT_SESSION_KEY) === "true";
      const evaluation = evaluateHomepageStartHereCallout(state, hasSeenCurrentSession);

      if (evaluation.shouldPersist) {
        writeStartHereCalloutState(localStorageRef, evaluation.nextState);
        safeStorageSetItem(sessionStorageRef, START_HERE_CALLOUT_SESSION_KEY, "true");
      }

      setShouldShow(evaluation.shouldShow);
    } catch {
      setShouldShow(true);
    } finally {
      setIsReady(true);
    }
  }, []);

  const retireCallout = useCallback(() => {
    const localStorageRef = getWindowStorage("local");
    if (localStorageRef) {
      try {
        persistStartHereOpened(localStorageRef);
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
