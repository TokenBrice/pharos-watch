"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    __PHAROS_CONSOLE_SIGNED__?: boolean;
  }
}

export function ConsoleSignature() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.__PHAROS_CONSOLE_SIGNED__) return;
    window.__PHAROS_CONSOLE_SIGNED__ = true;

    const wordmark = "%cPHAROS";
    const tag = "%c · Watching the peg.";
    const wordmarkStyle = "color:#7dd3fc;font-weight:700;font-family:monospace;font-size:14px;";
    const tagStyle = "color:#94a3b8;font-family:monospace;font-size:12px;";
    console.log(wordmark + tag, wordmarkStyle, tagStyle);
    console.log(
      "%cpharos.watch · github.com/TokenBrice/pharos-watch",
      "color:#64748b;font-family:monospace;font-size:11px;",
    );
    console.log(
      "%cYou opened devtools. We respect that. If you find a bad data point, the correction path is in the footer or here → github.com/TokenBrice/pharos-watch/issues",
      "color:#475569;font-family:monospace;font-size:11px;font-style:italic;",
    );
  }, []);

  return null;
}
