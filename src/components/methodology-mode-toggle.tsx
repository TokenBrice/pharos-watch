"use client";

import { useCallback, useEffect, useState } from "react";

type MethodologyMode = "reader" | "analyst";

const STORAGE_KEY = "pharos.methodology.mode";
const DETAILS_SELECTOR = 'details[data-methodology-details="true"]';
const PRIMARY_SELECTOR = 'details[data-methodology-primary="true"]';

function applyMethodologyMode(mode: MethodologyMode) {
  const details = document.querySelectorAll<HTMLDetailsElement>(DETAILS_SELECTOR);

  for (const detail of details) {
    detail.open = mode === "analyst";
  }

  if (mode === "reader") {
    const primary = document.querySelector<HTMLDetailsElement>(PRIMARY_SELECTOR);
    if (primary) {
      primary.open = true;
    }
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
    setMode(nextMode);
    window.localStorage.setItem(STORAGE_KEY, nextMode);
  }, []);

  return (
    <div className="inline-flex items-center rounded-md border border-border/60 bg-background p-1 text-xs">
      <button
        type="button"
        aria-pressed={mode === "reader"}
        onClick={() => setAndApplyMode("reader")}
        className={`rounded px-2 py-1 transition-colors ${mode === "reader" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        Reader
      </button>
      <button
        type="button"
        aria-pressed={mode === "analyst"}
        onClick={() => setAndApplyMode("analyst")}
        className={`rounded px-2 py-1 transition-colors ${mode === "analyst" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      >
        Analyst
      </button>
    </div>
  );
}
