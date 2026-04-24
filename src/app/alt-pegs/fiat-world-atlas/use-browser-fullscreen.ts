"use client";

import { useRef, type RefObject } from "react";

export function useBrowserFullscreen(_open: boolean): RefObject<HTMLDivElement | null> {
  return useRef<HTMLDivElement | null>(null);
}
