"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { FocusMode } from "@/components/contagion-graph-graph";
import type { ContagionGraphNodeSelectOption } from "@/components/contagion-graph/use-contagion-graph-model";

interface ContagionGraphControlsProps {
  focusMode: FocusMode;
  nodeSelectOptions: ContagionGraphNodeSelectOption[];
  selectedNeighborhoodId: string | null;
  onFocusModeChange: (focusMode: FocusMode) => void;
  onSelectedNeighborhoodChange: (nodeId: string | null) => void;
}

export function ContagionGraphControls({
  focusMode,
  nodeSelectOptions,
  selectedNeighborhoodId,
  onFocusModeChange,
  onSelectedNeighborhoodChange,
}: ContagionGraphControlsProps) {
  return (
    <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <span className="shrink-0 text-[10px] text-muted-foreground">Focus</span>
        <div className="w-0 min-w-0 flex-1 overflow-x-auto sm:w-auto sm:flex-none">
          <ToggleGroup
            type="single"
            value={focusMode}
            onValueChange={(value) => { if (value) onFocusModeChange(value as FocusMode); }}
            variant="outline"
            size="sm"
            className="inline-flex h-9 min-w-max md:h-7"
          >
            <ToggleGroupItem value="all" className="text-[10px]">All</ToggleGroupItem>
            <ToggleGroupItem value="hub" className="text-[10px]">Hub dependencies</ToggleGroupItem>
            <ToggleGroupItem value="neighborhood" className="text-[10px]">Selected neighborhood</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {focusMode === "neighborhood" && (
        <div className="flex w-full flex-col gap-1 sm:ml-auto sm:w-auto sm:items-end">
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            Coin
            <select
              className="h-9 max-w-full rounded-md border bg-background px-2 text-[11px] text-foreground md:h-7"
              value={selectedNeighborhoodId ?? ""}
              onChange={(event) => onSelectedNeighborhoodChange(event.target.value || null)}
            >
              {nodeSelectOptions.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.symbol}
                </option>
              ))}
            </select>
          </label>
          <span className="text-[10px] text-muted-foreground">Click any node to set neighborhood</span>
        </div>
      )}
    </div>
  );
}
