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
          // Browsers can deny fullscreen without user activation or permission.
          // The Dialog remains the supported fallback surface.
        });
      }
    }

    return () => {
      if (document.fullscreenElement === target) {
        const exited = document.exitFullscreen?.();
        if (exited && typeof exited.catch === "function") {
          exited.catch(() => {
            // Browser may have already exited fullscreen through Esc/F11.
          });
        }
      }
    };
  }, [open]);

  return targetRef;
}
