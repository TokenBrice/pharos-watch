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

export function MethodologyModeToggle({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const mode = useSyncExternalStore(modeStorage.subscribe, modeStorage.read, () => "reader" as const);

  useEffect(() => {
    applyMethodologyMode(mode);
  }, [mode]);

  const itemClassName = compact
    ? "pharos-segmented-item pharos-focus-ring min-h-10 justify-center px-2.5 md:min-h-8 md:px-3"
    : "pharos-segmented-item pharos-focus-ring min-h-11 justify-center md:min-h-8";

  return (
    <div
      role="group"
      aria-label="Methodology view mode"
      className={cn(
        "inline-flex flex-wrap items-center gap-2 text-xs",
        className,
      )}
    >
      <span className={cn("pharos-label text-xs", compact && "hidden md:inline")}>View</span>
      <div className="pharos-segmented">
        <button
          type="button"
          aria-pressed={mode === "reader"}
          onClick={() => modeStorage.write("reader")}
          className={itemClassName}
        >
          Reader
        </button>
        <button
          type="button"
          aria-pressed={mode === "analyst"}
          onClick={() => modeStorage.write("analyst")}
          className={itemClassName}
        >
          Analyst
        </button>
      </div>
    </div>
  );
}
