"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { EdgeTypeFilter, FocusMode } from "@/components/contagion-graph-graph";
import type { ContagionGraphNodeSelectOption } from "@/components/contagion-graph/use-contagion-graph-model";
import { NODE_LIMIT_OPTIONS, type NodeLimitOption } from "@/lib/contagion-layout";

const TYPE_FILTERS: readonly { value: EdgeTypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "collateral", label: "Collateral" },
  { value: "mechanism", label: "Mechanism" },
  { value: "wrapper", label: "Wrapper" },
];

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
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Focus
          </span>
          <div className="w-0 min-w-0 flex-1 overflow-x-auto 2xl:w-auto 2xl:flex-none">
            <ToggleGroup
              type="single"
              value={focusMode}
              aria-label="Graph focus mode"
              onValueChange={(value) => {
                if (value) onFocusModeChange(value as FocusMode);
              }}
              variant="outline"
              size="sm"
              className="inline-flex h-9 min-w-max rounded-md md:h-7"
            >
              <ToggleGroupItem value="all" className="font-mono text-[10px] uppercase tracking-[0.08em]">
                All
              </ToggleGroupItem>
              <ToggleGroupItem
                value="hub"
                aria-label="Hub dependencies"
                className="font-mono text-[10px] uppercase tracking-[0.08em]"
              >
                Hubs
              </ToggleGroupItem>
              <ToggleGroupItem
                value="neighborhood"
                aria-label="Selected neighborhood"
                className="font-mono text-[10px] uppercase tracking-[0.08em]"
              >
                Neighborhood
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <div className="flex w-full flex-col gap-1 2xl:ml-auto 2xl:w-auto 2xl:items-end">
          <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Trace coin
            <select
              className="h-9 max-w-full rounded-md border bg-background px-2 font-mono text-[11px] text-foreground md:h-7 2xl:w-[11rem]"
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
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Type</span>
        <div className="w-0 min-w-0 flex-1 overflow-x-auto">
          <ToggleGroup
            type="single"
            value={edgeTypeFilter}
            aria-label="Dependency type filter"
            onValueChange={(value) => {
              if (value) onEdgeTypeFilterChange(value as EdgeTypeFilter);
            }}
            variant="outline"
            size="sm"
            className="inline-flex h-9 min-w-max rounded-md md:h-7"
          >
            {TYPE_FILTERS.map((filter) => (
              <ToggleGroupItem
                key={filter.value}
                value={filter.value}
                className="font-mono text-[10px] uppercase tracking-[0.08em]"
              >
                {filter.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <div className="flex w-full items-center gap-2">
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Limit</span>
        <div className="w-0 min-w-0 flex-1 overflow-x-auto">
          <ToggleGroup
            type="single"
            value={String(nodeLimit)}
            aria-label="Maximum nodes shown"
            onValueChange={(value) => {
              if (value) onNodeLimitChange(Number(value) as NodeLimitOption);
            }}
            variant="outline"
            size="sm"
            className="inline-flex h-9 min-w-max rounded-md md:h-7"
          >
            {NODE_LIMIT_OPTIONS.map((limit) => (
              <ToggleGroupItem
                key={limit}
                value={String(limit)}
                className="font-mono text-[10px] uppercase tracking-[0.08em]"
              >
                {limit}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Focus narrows the visible subgraph; type filters which dependency edges are drawn; limit caps how many top-mcap coins enter the map.
      </p>
    </div>
  );
}
