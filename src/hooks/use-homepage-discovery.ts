"use client";

import { useEffect, useRef, useState } from "react";

import { getWindowStorage } from "@/lib/browser-storage";
import {
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  advanceHomepageDiscoveryRotation,
  selectHomepageDiscoverySuggestions,
  type HomepageDiscoverySuggestion,
} from "@/lib/homepage-discovery";

const DEFAULT_HOMEPAGE_DISCOVERY_SUGGESTIONS = selectHomepageDiscoverySuggestions(
  HOMEPAGE_DISCOVERY_ROTATION_POOL,
  0,
);

export function useHomepageDiscoverySuggestions(): readonly HomepageDiscoverySuggestion[] {
  const [suggestions, setSuggestions] = useState(DEFAULT_HOMEPAGE_DISCOVERY_SUGGESTIONS);
  const recordedVisitRef = useRef(false);

  useEffect(() => {
    if (recordedVisitRef.current) return;
    recordedVisitRef.current = true;

    const timeout = window.setTimeout(() => {
      const visitIndex = advanceHomepageDiscoveryRotation(getWindowStorage("local"));
      setSuggestions(selectHomepageDiscoverySuggestions(HOMEPAGE_DISCOVERY_ROTATION_POOL, visitIndex));
    }, 0);

    return () => window.clearTimeout(timeout);
  }, []);

  return suggestions;
}
