"use client";

import { useEffect } from "react";
import { markStartHereOpened, readStartHereCalloutState, writeStartHereCalloutState } from "@/lib/start-here-callout";

export function StartHereVisitMarker() {
  useEffect(() => {
    try {
      const nextState = markStartHereOpened(readStartHereCalloutState(window.localStorage));
      writeStartHereCalloutState(window.localStorage, nextState);
    } catch {
      // Ignore unavailable storage; the homepage hook will still fall back safely.
    }
  }, []);

  return null;
}
