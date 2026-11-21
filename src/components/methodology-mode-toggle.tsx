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
        "inline-flex flex-wrap items-center gap-2 text-xs",
        className,
      )}
    >
      <span className="pharos-label text-xs">View</span>
      <div className="pharos-segmented">
        <button
          type="button"
          aria-pressed={mode === "reader"}
          onClick={() => modeStorage.write("reader")}
          className="pharos-segmented-item pharos-focus-ring min-h-11 justify-center md:min-h-8"
        >
          Reader
        </button>
        <button
          type="button"
          aria-pressed={mode === "analyst"}
          onClick={() => modeStorage.write("analyst")}
          className="pharos-segmented-item pharos-focus-ring min-h-11 justify-center md:min-h-8"
        >
          Analyst
        </button>
      </div>
    </div>
  );
}
