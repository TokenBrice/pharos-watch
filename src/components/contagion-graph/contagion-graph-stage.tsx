"use client";

import type { ReactNode } from "react";
import { ContagionGraphLegend } from "@/components/contagion-graph/contagion-graph-legend";
import { ContagionGraphSvg } from "@/components/contagion-graph/contagion-graph-svg";
import { GRAPH_GRID_SIZE_PX } from "@/components/contagion-graph/contagion-graph-tokens";
import type { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";

type ContagionGraphModel = ReturnType<typeof useContagionGraphModel>;

interface ContagionGraphStageProps {
  graph: ContagionGraphModel;
  logos?: Record<string, string>;
  detailNodePresentation?: boolean;
  nodeTooltipEl: ReactNode;
  edgeTooltipEl: ReactNode;
  overlay?: ReactNode;
}

export function ContagionGraphStage({
  graph,
  logos,
  detailNodePresentation,
  nodeTooltipEl,
  edgeTooltipEl,
  overlay,
}: ContagionGraphStageProps) {
  const showTickerLabels = Boolean(detailNodePresentation && graph.visibleNodeIds.size <= 10);
  const detailNodeScale = detailNodePresentation
    ? graph.visibleNodeIds.size <= 5
      ? 3
      : graph.visibleNodeIds.size <= 10
        ? 2
        : 1
    : 1;
  return (
    <div
      className="relative w-full overflow-hidden rounded-sm border"
      style={{
        backgroundColor: "var(--graph-canvas-bg)",
        borderColor: "var(--graph-grid-line)",
        backgroundImage:
          "linear-gradient(to right, var(--graph-grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--graph-grid-line) 1px, transparent 1px)",
        backgroundSize: `${GRAPH_GRID_SIZE_PX}px ${GRAPH_GRID_SIZE_PX}px`,
      }}
      role="figure"
      aria-label={`Dependency graph showing ${graph.visibleNodeIds.size} visible stablecoins and ${graph.visibleLinks.length} visible dependency connections`}
    >
      {overlay}
      <ContagionGraphSvg
        svgRef={graph.svgRef}
        nodes={graph.nodes}
        visibleLinks={graph.visibleLinks}
        visibleNodeIds={graph.visibleNodeIds}
        positions={graph.positions}
        dragId={graph.dragId}
        focusMode={graph.focusMode}
        supernodeState={graph.supernodeState}
        logos={logos}
        logoZoom={detailNodePresentation && detailNodeScale === 1 ? 1.33 : 1}
        nodeScale={detailNodeScale}
        suppressHubLabels={Boolean(detailNodePresentation)}
        showTickerLabels={showTickerLabels}
        activeHoveredId={graph.activeHoveredId}
        activeHoveredEdge={graph.activeHoveredEdge}
        focusedId={graph.focusedId}
        pinnedSelectionId={graph.pinnedSelectionId}
        pinnedNodeIds={graph.pinnedNodeIds}
        connectedNodes={graph.connectedNodes}
        connectedEdges={graph.connectedEdges}
        nodeDistance={graph.nodeDistance}
        edgeDistance={graph.edgeDistance}
        nodeTooltipEl={nodeTooltipEl}
        edgeTooltipEl={edgeTooltipEl}
        onPointerMove={graph.handlePointerMove}
        onPointerUp={graph.handlePointerUp}
        onNodePointerDown={graph.handlePointerDown}
        onNodeKeyDown={graph.handleNodeKeyDown}
        onNodeMouseEnter={graph.handleNodeMouseEnter}
        onNodeMouseLeave={graph.handleNodeMouseLeave}
        onNodeFocus={graph.handleNodeFocus}
        onNodeBlur={graph.handleNodeBlur}
        onNodeClick={graph.handleNodeClick}
        onNodeDoubleClick={graph.handleNodeDoubleClick}
        onEdgeMouseEnter={graph.handleEdgeMouseEnter}
        onEdgeMouseLeave={graph.handleEdgeMouseLeave}
        onCanvasClick={graph.handleClearSelection}
      />
      <div
        className="pointer-events-none absolute bottom-2 left-2 hidden max-w-[calc(100%-1rem)] rounded-sm border px-2 py-1.5 backdrop-blur-sm sm:block"
        style={{ backgroundColor: "var(--graph-panel-bg)", borderColor: "var(--graph-grid-line)" }}
      >
        <ContagionGraphLegend />
      </div>
      <div
        className="border-t px-3 py-2 sm:hidden"
        style={{ borderColor: "var(--graph-grid-line)" }}
      >
        <ContagionGraphLegend />
      </div>
    </div>
  );
}
