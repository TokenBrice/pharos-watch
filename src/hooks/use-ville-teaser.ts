"use client";

import { useCallback, useEffect, useState } from "react";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";

const STORAGE_KEY = "pharos-ville-teaser-dismissed";

export function useVilleTeaser() {
  const [shouldShow, setShouldShow] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const storage = getWindowStorage("local");
    const dismissed = storage ? safeStorageGetItem(storage, STORAGE_KEY) === "true" : false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShouldShow(!dismissed);
    setIsReady(true);
  }, []);

  const dismiss = useCallback(() => {
    const storage = getWindowStorage("local");
    if (storage) safeStorageSetItem(storage, STORAGE_KEY, "true");
    setShouldShow(false);
  }, []);

  return { isReady, shouldShow, dismiss };
}
