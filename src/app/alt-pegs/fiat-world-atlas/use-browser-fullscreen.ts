"use client";

import { useEffect, useRef, type RefObject } from "react";

export function useBrowserFullscreen(open: boolean): RefObject<HTMLDivElement | null> {
  const targetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!document.fullscreenEnabled) return;
    const target = targetRef.current;
    if (!target) return;

    if (open && document.fullscreenElement !== target) {
      const requested = target.requestFullscreen?.();
      if (requested && typeof requested.catch === "function") {
        requested.catch(() => {
          // MDN: rejects with TypeError when denied (no activation, permissions
          // policy, iframe without allowfullscreen, etc.). Silently accept —
          // the Radix Dialog remains the fallback.
        });
      }
    }

    return () => {
      if (document.fullscreenElement === target) {
        const exited = document.exitFullscreen?.();
        if (exited && typeof exited.catch === "function") {
          exited.catch(() => {
            // Swallow — browser may have already exited via Esc/F11.
          });
        }
      }
    };
  }, [open]);

  return targetRef;
}
