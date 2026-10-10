"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createBrowserStorageStore } from "@/lib/browser-storage";
import { cn } from "@/lib/utils";

type MethodologyMode = "reader" | "analyst";

const STORAGE_KEY = "pharos.methodology.mode";
const modeStorage = createBrowserStorageStore<MethodologyMode>({
  key: STORAGE_KEY,
  fallback: "reader",
  decode: (stored) => (stored === "analyst" ? "analyst" : "reader"),
});
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
  const mode = useSyncExternalStore(modeStorage.subscribe, modeStorage.read, () => "reader" as const);

  useEffect(() => {
    applyMethodologyMode(mode);
  }, [mode]);


  return (
    <div
      role="group"
      aria-label="Methodology view mode"
      className={cn(
        "inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-border/60 bg-background/85 p-1.5 text-xs md:gap-2 md:rounded-full md:px-2 md:py-1",
        className,
      )}
    >
      <span className="pharos-kicker px-1 text-xs">View</span>
      <button
        type="button"
        aria-pressed={mode === "reader"}
        data-state={mode === "reader" ? "on" : "off"}
        onClick={() => modeStorage.write("reader")}
        className="pharos-toggle-pill pharos-focus-ring min-h-11 justify-center md:min-h-9"
      >
        Reader
      </button>
      <button
        type="button"
        aria-pressed={mode === "analyst"}
        data-state={mode === "analyst" ? "on" : "off"}
        onClick={() => modeStorage.write("analyst")}
        className="pharos-toggle-pill pharos-focus-ring min-h-11 justify-center md:min-h-9"
      >
        Analyst
      </button>
    </div>
  );
}
