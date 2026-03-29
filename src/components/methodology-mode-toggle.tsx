"use client";

import { useCallback, useEffect, useState } from "react";
import { getWindowStorage, safeStorageGetItem, safeStorageSetItem } from "@/lib/browser-storage";
import { cn } from "@/lib/utils";

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

export function MethodologyModeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useState<MethodologyMode>(() => {
    return safeStorageGetItem(getWindowStorage("local"), STORAGE_KEY) === "analyst" ? "analyst" : "reader";
  });

  useEffect(() => {
    applyMethodologyMode(mode);
  }, [mode]);

  const setAndApplyMode = useCallback((nextMode: MethodologyMode) => {
    setMode(nextMode);
    safeStorageSetItem(getWindowStorage("local"), STORAGE_KEY, nextMode);
  }, []);

  return (
    <div
      role="group"
      aria-label="Methodology view mode"
      className={cn(
        "inline-flex flex-wrap items-center gap-1.5 rounded-[1.1rem] border border-border/60 bg-background/85 p-1.5 text-xs shadow-sm md:gap-2 md:rounded-full md:px-2 md:py-1",
        className,
      )}
    >
      <span className="pharos-kicker px-1 text-xs">View</span>
      <button
        type="button"
        aria-pressed={mode === "reader"}
        onClick={() => setAndApplyMode("reader")}
        className={cn(
          "pharos-focus-ring inline-flex min-h-11 items-center justify-center rounded-full px-3.5 py-2 transition-colors md:min-h-8 md:px-3 md:py-1.5",
          mode === "reader" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        Reader
      </button>
      <button
        type="button"
        aria-pressed={mode === "analyst"}
        onClick={() => setAndApplyMode("analyst")}
        className={cn(
          "pharos-focus-ring inline-flex min-h-11 items-center justify-center rounded-full px-3.5 py-2 transition-colors md:min-h-8 md:px-3 md:py-1.5",
          mode === "analyst" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        Analyst
      </button>
    </div>
  );
}
