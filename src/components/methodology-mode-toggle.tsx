"use client";

import { useCallback, useEffect, useState } from "react";

type MethodologyMode = "reader" | "analyst";

const STORAGE_KEY = "pharos.methodology.mode";
const DETAILS_SELECTOR = 'details[data-methodology-details="true"]';
const WORKED_EXAMPLE_SELECTOR = 'details[data-methodology-worked-example="true"]';
const MODE_CONTROLLED_SELECTOR = `${DETAILS_SELECTOR}, ${WORKED_EXAMPLE_SELECTOR}`;

function applyMethodologyMode(mode: MethodologyMode) {
  const details = document.querySelectorAll<HTMLDetailsElement>(MODE_CONTROLLED_SELECTOR);

  for (const detail of details) {
    detail.open = mode === "analyst";
  }
}

export function MethodologyModeToggle() {
  const [mode, setMode] = useState<MethodologyMode>(() => {
    if (typeof window === "undefined") {
      return "reader";
    }
    return window.localStorage.getItem(STORAGE_KEY) === "analyst" ? "analyst" : "reader";
  });

  useEffect(() => {
    applyMethodologyMode(mode);
  }, [mode]);

  const setAndApplyMode = useCallback((nextMode: MethodologyMode) => {
    applyMethodologyMode(nextMode);
    setMode(nextMode);
    window.localStorage.setItem(STORAGE_KEY, nextMode);
  }, []);

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/85 px-2 py-1 text-xs shadow-sm">
      <span className="pharos-kicker text-[10px]">View</span>
      <button
        type="button"
        aria-pressed={mode === "reader"}
        onClick={() => setAndApplyMode("reader")}
        className={`rounded-full px-3 py-1.5 transition-colors ${mode === "reader" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        Reader
      </button>
      <button
        type="button"
        aria-pressed={mode === "analyst"}
        onClick={() => setAndApplyMode("analyst")}
        className={`rounded-full px-3 py-1.5 transition-colors ${mode === "analyst" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        Analyst
      </button>
    </div>
  );
}
