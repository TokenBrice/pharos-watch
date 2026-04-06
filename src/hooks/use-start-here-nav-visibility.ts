"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getWindowStorage } from "@/lib/browser-storage";
import { readStartHereCalloutState, shouldShowStartHereNavigation } from "@/lib/start-here-callout";

export function useStartHereNavVisibility() {
  const pathname = usePathname();
  const [shouldShow, setShouldShow] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (pathname.startsWith("/start")) {
      setShouldShow(false);
      setIsReady(true);
      return;
    }

    const localStorageRef = getWindowStorage("local");
    if (!localStorageRef) {
      setShouldShow(true);
      setIsReady(true);
      return;
    }

    try {
      setShouldShow(shouldShowStartHereNavigation(readStartHereCalloutState(localStorageRef)));
    } catch {
      setShouldShow(true);
    } finally {
      setIsReady(true);
    }
  }, [pathname]);

  return {
    isReady,
    shouldShow,
  };
}
