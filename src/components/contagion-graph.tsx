"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ContagionGraphControls } from "@/components/contagion-graph/contagion-graph-controls";
import { ContagionGraphLegend } from "@/components/contagion-graph/contagion-graph-legend";
import { ContagionGraphSvg } from "@/components/contagion-graph/contagion-graph-svg";
import { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import {
  buildEdgeTooltipElement,
  buildNodeTooltipElement,
  buildTooltipAnnouncement,
} from "@/components/contagion-graph-tooltips";
import { HEIGHT, PAD, WIDTH } from "@/lib/contagion-layout";
import type { ReportCard, ReportCardsResponse } from "@shared/types";

interface ContagionGraphProps {
  cards: ReportCard[];
  dependencyEdges?: ReportCardsResponse["dependencyGraph"]["edges"];
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
}

export function ContagionGraph({ cards, dependencyEdges, mcapMap, logos }: ContagionGraphProps) {
  const graph = useContagionGraphModel({ cards, dependencyEdges, mcapMap });

  if (graph.nodes.length === 0) return null;

  const tooltipContext = {
    activeHoveredId: graph.activeHoveredId,
    activeHoveredEdge: graph.activeHoveredEdge,
    cards,
    nodeMap: graph.nodeMap,
    positions: graph.positions,
    resolvedLinkByIndex: graph.resolvedLinkByIndex,
    width: WIDTH,
    height: HEIGHT,
    pad: PAD,
  };
  const tooltipAnnouncement = buildTooltipAnnouncement(tooltipContext);
  const nodeTooltipEl = buildNodeTooltipElement(tooltipContext);
  const edgeTooltipEl = buildEdgeTooltipElement(tooltipContext);

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <p className="text-xs text-muted-foreground">
          Showing {graph.visibleNodeIds.size} of {graph.nodes.length} dependency-linked stablecoins with {graph.visibleLinks.length} visible edges.
          Adaptive supernode emphasis keeps key hubs centered and their links visually prioritized.
        </p>
        <ContagionGraphControls
          focusMode={graph.focusMode}
          nodeSelectOptions={graph.nodeSelectOptions}
          selectedNeighborhoodId={graph.effectiveSelectedNeighborhoodId}
          onFocusModeChange={graph.setFocusMode}
          onSelectedNeighborhoodChange={graph.setSelectedNeighborhoodId}
        />
        <ContagionGraphLegend />
      </CardHeader>
      <CardContent>
        <div
          className="w-full overflow-hidden rounded-lg border bg-background/50"
          role="figure"
          aria-label={`Dependency graph showing ${graph.visibleNodeIds.size} visible stablecoins and ${graph.visibleLinks.length} visible dependency connections`}
        >
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
        </div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {tooltipAnnouncement}
        </div>
      </CardContent>
    </Card>
  );
}
