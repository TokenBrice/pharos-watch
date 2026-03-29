"use client";

import { useEffect } from "react";
import { persistStartHereOpened } from "@/lib/start-here-callout";
import { getWindowStorage } from "@/lib/browser-storage";

export function StartHereVisitMarker() {
  useEffect(() => {
    const localStorageRef = getWindowStorage("local");
    if (!localStorageRef) return;
    try {
      persistStartHereOpened(localStorageRef);
    } catch {
      // Ignore unavailable storage; the homepage hook will still fall back safely.
    }
  }, []);

  return null;
}
