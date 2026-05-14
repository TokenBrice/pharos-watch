"use client";

import type { ReactNode } from "react";
import { ContagionGraphLegend } from "@/components/contagion-graph/contagion-graph-legend";
import { ContagionGraphSvg } from "@/components/contagion-graph/contagion-graph-svg";
import type { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";

type ContagionGraphModel = ReturnType<typeof useContagionGraphModel>;

interface ContagionGraphStageProps {
  graph: ContagionGraphModel;
  logos?: Record<string, string>;
  nodeTooltipEl: ReactNode;
  edgeTooltipEl: ReactNode;
}

export function ContagionGraphStage({ graph, logos, nodeTooltipEl, edgeTooltipEl }: ContagionGraphStageProps) {
  return (
    <div
      className="relative w-full overflow-hidden rounded-md border border-border/70 bg-background/80"
      style={{
        backgroundImage:
          "linear-gradient(to right, color-mix(in oklch, var(--border) 34%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklch, var(--border) 34%, transparent) 1px, transparent 1px)",
        backgroundSize: "32px 32px",
      }}
      role="figure"
      aria-label={`Dependency graph showing ${graph.visibleNodeIds.size} visible stablecoins and ${graph.visibleLinks.length} visible dependency connections`}
    >
      <div className="pointer-events-none absolute right-3 top-3 z-10 hidden items-center gap-1 sm:flex">
        <span className="rounded-sm border border-frost-blue/70 bg-background/85 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-frost-blue">
          Systemic
        </span>
        <span className="rounded-sm border border-border/70 bg-background/85 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Leaf
        </span>
      </div>
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
        activeHoveredId={graph.activeHoveredId}
        activeHoveredEdge={graph.activeHoveredEdge}
        focusedId={graph.focusedId}
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
        onEdgeMouseEnter={graph.handleEdgeMouseEnter}
        onEdgeMouseLeave={graph.handleEdgeMouseLeave}
      />
      <div className="pointer-events-none absolute bottom-3 left-3 hidden max-w-[calc(100%-1.5rem)] rounded-md border border-border/70 bg-card/90 px-3 py-2 shadow-sm backdrop-blur-sm sm:block">
        <ContagionGraphLegend />
      </div>
      <div className="border-t border-border/60 px-3 py-2 sm:hidden">
        <ContagionGraphLegend />
      </div>
    </div>
  );
}
