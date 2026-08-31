"use client";

import { useCallback, useState } from "react";

export function useImageUnavailable() {
  const [unavailable, setUnavailable] = useState(false);
  const markUnavailable = useCallback(() => setUnavailable(true), []);
  const checkAlreadyFailed = useCallback((image: HTMLImageElement | null) => {
    if (image && image.complete && image.naturalWidth === 0) {
      markUnavailable();
    }
  }, [markUnavailable]);

  return {
    unavailable,
    checkAlreadyFailed,
    onError: markUnavailable,
  };
}
