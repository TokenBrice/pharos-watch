"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { STATUS_OK_PILL_CLASS } from "@/lib/status-dashboard-model";

export type WorkspaceModeSeverity = "healthy" | "watch" | "critical" | "unknown";

export interface WorkspaceModeSummary<TMode extends string> {
  id: TMode;
  label: string;
  issueCount: number;
  severity: WorkspaceModeSeverity;
}

const SEVERITY_CLASS: Record<WorkspaceModeSeverity, string> = {
  healthy: STATUS_OK_PILL_CLASS,
  watch: SEVERITY_TONE_CLASS.watch.pill,
  critical: SEVERITY_TONE_CLASS.alert.pill,
  unknown: "border-border bg-muted text-muted-foreground",
};

interface WorkspaceModeTabsProps<TMode extends string> {
  activeMode: TMode;
  modes: readonly WorkspaceModeSummary<TMode>[];
  onModeChange: (mode: TMode) => void;
  ariaLabel: string;
  className?: string;
  tabClassName: string;
  getTabId: (mode: TMode) => string;
  getPanelId: (mode: TMode) => string;
}

export function createWorkspaceModeIds(prefix: string) {
  return {
    getTabId: (mode: string) => `${prefix}-tab-${mode}`,
    getPanelId: (mode: string) => `${prefix}-panel-${mode}`,
  };
}

export function WorkspaceModeTabs<TMode extends string>({
  activeMode,
  modes,
  onModeChange,
  ariaLabel,
  className,
  tabClassName,
  getTabId,
  getPanelId,
}: WorkspaceModeTabsProps<TMode>): React.JSX.Element {
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
      aria-label={ariaLabel}
      className={cn("min-w-0 max-w-full overflow-x-auto border-b border-border/70 pb-2 scrollbar-none", className)}
      style={{ contain: "paint" }}
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
              id={getTabId(mode.id)}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={isActive ? getPanelId(mode.id) : undefined}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onModeChange(mode.id)}
              onKeyDown={(event) => moveSelection(event, index)}
              className={cn(
                "pharos-focus-ring inline-flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 text-xs font-medium transition-colors motion-reduce:transition-none",
                tabClassName,
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
