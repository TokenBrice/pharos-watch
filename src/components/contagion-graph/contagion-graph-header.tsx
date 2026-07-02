"use client";

import { ContagionGraphControls } from "@/components/contagion-graph/contagion-graph-controls";
import type { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";

type ContagionGraphModel = ReturnType<typeof useContagionGraphModel>;

interface ContagionGraphHeaderProps {
  graph: ContagionGraphModel;
}

function countVisibleHubs(graph: ContagionGraphModel): number {
  return graph.nodes.filter((node) => (graph.supernodeState.tierById.get(node.id) ?? 0) > 0).length;
}

export function ContagionGraphHeader({ graph }: ContagionGraphHeaderProps) {
  const hubCount = countVisibleHubs(graph);

  return (
    <>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">
            Stablecoin Dependency Map
          </p>
          <p className="text-sm text-muted-foreground">
            Adaptive supernode emphasis keeps key hubs centered while the inspection rail tracks the current node.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {graph.pinnedNodeIds.size > 0 && (
            <button
              type="button"
              onClick={graph.unpinAll}
              aria-label={`Unpin all ${graph.pinnedNodeIds.size} pinned nodes`}
              className="pharos-focus-ring pharos-control-pill h-11 gap-1.5 px-3 md:h-9"
            >
              <span>Pinned · {graph.pinnedNodeIds.size}</span>
              <span aria-hidden="true">×</span>
            </button>
          )}
          <div className="grid grid-cols-3 divide-x divide-border/60 sm:w-auto">
            <div className="px-3 py-2 first:pl-0">
              <p className="pharos-kicker">Visible</p>
              <p className="pharos-numeric text-sm font-semibold text-foreground">
                {graph.visibleNodeIds.size}/{graph.nodes.length}
              </p>
            </div>
            <div className="px-3 py-2">
              <p className="pharos-kicker">Edges</p>
              <p className="pharos-numeric text-sm font-semibold text-foreground">
                {graph.visibleLinks.length}
              </p>
            </div>
            <div className="px-3 py-2 last:pr-0">
              <p className="pharos-kicker">Hubs</p>
              <p className="pharos-numeric text-sm font-semibold text-foreground">{hubCount}</p>
            </div>
          </div>
        </div>
      </div>
      <ContagionGraphControls
        focusMode={graph.focusMode}
        nodeSelectOptions={graph.nodeSelectOptions}
        selectedNeighborhoodId={graph.effectiveSelectedNeighborhoodId}
        onFocusModeChange={graph.setFocusMode}
        edgeTypeFilter={graph.edgeTypeFilter}
        onEdgeTypeFilterChange={graph.setEdgeTypeFilter}
        nodeLimit={graph.nodeLimit}
        onNodeLimitChange={graph.setNodeLimit}
        onTraceNodeChange={graph.handleTraceNodeChange}
      />
    </>
  );
}
