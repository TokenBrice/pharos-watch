"use client";

import { cn } from "@/lib/utils";
import type { EdgeTypeFilter, FocusMode } from "@/components/contagion-graph-graph";
import { DEPENDENCY_TYPE_FILTERS } from "@/components/contagion-graph-model";
import type { ContagionGraphNodeSelectOption } from "@/components/contagion-graph/use-contagion-graph-model";
import { NODE_LIMIT_OPTIONS, type NodeLimitOption } from "@/lib/contagion-layout";

interface ContagionGraphControlsProps {
  focusMode: FocusMode;
  edgeTypeFilter: EdgeTypeFilter;
  nodeLimit: NodeLimitOption;
  nodeSelectOptions: ContagionGraphNodeSelectOption[];
  selectedNeighborhoodId: string | null;
  onFocusModeChange: (focusMode: FocusMode) => void;
  onEdgeTypeFilterChange: (edgeTypeFilter: EdgeTypeFilter) => void;
  onNodeLimitChange: (limit: NodeLimitOption) => void;
  onTraceNodeChange: (nodeId: string | null) => void;
}

const FOCUS_OPTIONS: { value: FocusMode; label: string; ariaLabel?: string }[] = [
  { value: "all", label: "All" },
  { value: "hub", label: "Hubs", ariaLabel: "Hub dependencies" },
  { value: "neighborhood", label: "Neighborhood", ariaLabel: "Selected neighborhood" },
];

function ControlPill({
  isActive,
  ariaLabel,
  onClick,
  children,
}: {
  isActive: boolean;
  ariaLabel?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      aria-label={ariaLabel}
      className={cn(
        "pharos-focus-ring pharos-control-pill px-3 py-1",
        isActive ? "pharos-control-pill-active" : "",
      )}
    >
      {children}
    </button>
  );
}

export function ContagionGraphControls({
  focusMode,
  edgeTypeFilter,
  nodeLimit,
  nodeSelectOptions,
  selectedNeighborhoodId,
  onFocusModeChange,
  onEdgeTypeFilterChange,
  onNodeLimitChange,
  onTraceNodeChange,
}: ContagionGraphControlsProps) {
  return (
    <div className="grid gap-3 pt-1">
      <div className="flex flex-col gap-2 2xl:flex-row 2xl:flex-wrap 2xl:items-center 2xl:justify-between">
        <div className="flex w-full items-center gap-2 2xl:w-auto">
          <span className="pharos-kicker shrink-0">
            Focus
          </span>
          <div
            role="group"
            aria-label="Graph focus mode"
            className="flex min-w-0 flex-1 flex-wrap gap-1.5 2xl:flex-none"
          >
            {FOCUS_OPTIONS.map((option) => (
              <ControlPill
                key={option.value}
                isActive={focusMode === option.value}
                ariaLabel={option.ariaLabel}
                onClick={() => onFocusModeChange(option.value)}
              >
                {option.label}
              </ControlPill>
            ))}
          </div>
        </div>

        <div className="flex w-full flex-col gap-1 2xl:ml-auto 2xl:w-auto 2xl:items-end">
          <label className="flex items-center gap-2">
            <span className="pharos-kicker shrink-0">Trace coin</span>
            <select
              className="pharos-focus-ring h-11 max-w-full rounded-full border border-[color:var(--control-pill-border)] bg-[color:var(--control-pill-bg)] px-3 text-xs font-medium text-foreground md:h-9 2xl:w-[11rem]"
              value={selectedNeighborhoodId ?? ""}
              onChange={(event) => onTraceNodeChange(event.target.value || null)}
            >
              {nodeSelectOptions.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.symbol}
                </option>
              ))}
            </select>
          </label>
          <span className="text-[10px] text-muted-foreground">
            Selecting a coin opens its neighborhood; clicking a node pins this target.
          </span>
        </div>
      </div>

      <div className="flex w-full items-center gap-2">
        <span className="pharos-kicker shrink-0">Type</span>
        <div role="group" aria-label="Dependency type filter" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {DEPENDENCY_TYPE_FILTERS.map((filter) => (
            <ControlPill
              key={filter.value}
              isActive={edgeTypeFilter === filter.value}
              onClick={() => onEdgeTypeFilterChange(filter.value)}
            >
              {filter.label}
            </ControlPill>
          ))}
        </div>
      </div>

      <div className="flex w-full items-center gap-2">
        <span className="pharos-kicker shrink-0">Limit</span>
        <div role="group" aria-label="Maximum nodes shown" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {NODE_LIMIT_OPTIONS.map((limit) => (
            <ControlPill
              key={limit}
              isActive={nodeLimit === limit}
              onClick={() => onNodeLimitChange(limit)}
            >
              {limit === "all" ? "All" : limit}
            </ControlPill>
          ))}
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Focus narrows the visible subgraph; type filters which dependency edges are drawn; limit caps how many top-mcap coins enter the map.
      </p>
    </div>
  );
}
