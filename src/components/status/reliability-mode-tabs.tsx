"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { ReliabilityMode, ReliabilityModeSummary, ReliabilitySeverity } from "@/lib/reliability-workspace-model";
import { cn } from "@/lib/utils";

const SEVERITY_CLASS: Record<ReliabilitySeverity, string> = {
  healthy: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  watch: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  critical: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  unknown: "border-border bg-muted text-muted-foreground",
};

export function getReliabilityTabId(mode: ReliabilityMode): string {
  return `reliability-tab-${mode}`;
}

export function getReliabilityPanelId(mode: ReliabilityMode): string {
  return `reliability-panel-${mode}`;
}

export function ReliabilityModeTabs({
  activeMode,
  modes,
  onModeChange,
}: {
  activeMode: ReliabilityMode;
  modes: ReliabilityModeSummary[];
  onModeChange: (mode: ReliabilityMode) => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % modes.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + modes.length) % modes.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = modes.length - 1;
    if (nextIndex == null) return;

    event.preventDefault();
    const nextMode = modes[nextIndex];
    if (!nextMode) return;
    onModeChange(nextMode.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Reliability views"
      className="min-w-0 max-w-full overflow-x-auto border-b border-border/70 pb-2 scrollbar-none"
    >
      <div className="flex min-w-max gap-1.5">
        {modes.map((mode, index) => {
          const active = mode.id === activeMode;
          return (
            <button
              key={mode.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={getReliabilityTabId(mode.id)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={active ? getReliabilityPanelId(mode.id) : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => onModeChange(mode.id)}
              onKeyDown={(event) => moveSelection(event, index)}
              className={cn(
                "pharos-focus-ring inline-flex min-h-10 min-w-[7.5rem] items-center justify-between gap-2 rounded-md border px-3 text-xs font-medium transition-colors",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border/70 bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <span>{mode.label}</span>
              <span
                className={cn(
                  "inline-flex min-w-5 items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                  active ? "border-background/30 bg-background/10 text-background" : SEVERITY_CLASS[mode.severity],
                )}
                title={`${mode.issueCount} issues; ${mode.severity}`}
              >
                {mode.issueCount}
                <span className="sr-only"> issues, {mode.severity}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
