"use client";

import { useEffect, useRef, useCallback } from "react";

interface DataUpdateAnnouncement {
  dataUpdatedAt: number;
  dataName: string;
}

/**
 * Hook to announce data updates to screen readers.
 * Uses a polite live region to notify users when fresh data is available.
 */
export function useDataAnnounce(updates: DataUpdateAnnouncement[]) {
  const previousUpdates = useRef<Record<string, number>>({});
  const announce = useCallback((message: string) => {
    const liveRegion = document.getElementById("pharos-data-live-region");
    if (liveRegion) {
      liveRegion.textContent = message;
      // Clear after announcement to avoid repetition
      setTimeout(() => {
        liveRegion.textContent = "";
      }, 1000);
    }
  }, []);

  useEffect(() => {
    const updatesToAnnounce: string[] = [];
    
    for (const { dataUpdatedAt, dataName } of updates) {
      const previous = previousUpdates.current[dataName];
      if (dataUpdatedAt > 0 && previous && dataUpdatedAt > previous) {
        updatesToAnnounce.push(dataName);
      }
      previousUpdates.current[dataName] = dataUpdatedAt;
    }

    if (updatesToAnnounce.length > 0) {
      const timestamp = new Date().toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      if (updatesToAnnounce.length === 1) {
        announce(`${updatesToAnnounce[0]} data refreshed at ${timestamp}`);
      } else {
        announce(`Data refreshed at ${timestamp}: ${updatesToAnnounce.join(", ")}`);
      }
    }
  }, [updates, announce]);
}
