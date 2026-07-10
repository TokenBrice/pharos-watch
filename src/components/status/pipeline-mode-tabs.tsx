"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { PipelineMode, PipelineModeSummary, PipelineSeverity } from "@/lib/pipeline-workspace-model";
import { cn } from "@/lib/utils";

const SEVERITY_CLASS: Record<PipelineSeverity, string> = {
  healthy: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  watch: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  critical: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  unknown: "border-border bg-muted text-muted-foreground",
};

export function getPipelineTabId(mode: PipelineMode): string {
  return `pipeline-tab-${mode}`;
}

export function getPipelinePanelId(mode: PipelineMode): string {
  return `pipeline-panel-${mode}`;
}

export function PipelineModeTabs({
  activeMode,
  modes,
  onModeChange,
}: {
  activeMode: PipelineMode;
  modes: PipelineModeSummary[];
  onModeChange: (mode: PipelineMode) => void;
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
      aria-label="Pipeline views"
      className="w-full min-w-0 max-w-full overflow-x-auto border-b border-border/70 pb-2 scrollbar-none"
    >
      <div className="flex min-w-max gap-1.5">
        {modes.map((mode, index) => {
          const isActive = mode.id === activeMode;
          return (
            <button
              key={mode.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              id={getPipelineTabId(mode.id)}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={isActive ? getPipelinePanelId(mode.id) : undefined}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onModeChange(mode.id)}
              onKeyDown={(event) => moveSelection(event, index)}
              className={cn(
                "pharos-focus-ring inline-flex min-h-11 min-w-[6.5rem] items-center justify-between gap-2 rounded-md border px-3 text-xs font-medium transition-colors motion-reduce:transition-none",
                isActive
                  ? "border-foreground bg-foreground text-background forced-colors:border-[Highlight] forced-colors:text-[Highlight]"
                  : "border-border/70 bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <span>{mode.label}</span>
              <span
                className={cn(
                  "inline-flex min-w-5 items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                  isActive
                    ? "border-background/30 bg-background/10 text-background forced-colors:border-[Highlight] forced-colors:text-[Highlight]"
                    : SEVERITY_CLASS[mode.severity],
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
