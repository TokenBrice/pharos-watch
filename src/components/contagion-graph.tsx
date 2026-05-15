"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ContagionGraphHeader } from "@/components/contagion-graph/contagion-graph-header";
import { ContagionGraphInsights } from "@/components/contagion-graph/contagion-graph-insights";
import { ContagionGraphStage } from "@/components/contagion-graph/contagion-graph-stage";
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
  focusCoinId?: string;
  minimalChrome?: boolean;
}

export function ContagionGraph({
  cards,
  dependencyEdges,
  mcapMap,
  logos,
  focusCoinId,
  minimalChrome,
}: ContagionGraphProps) {
  const graph = useContagionGraphModel({ cards, dependencyEdges, mcapMap, focusCoinId });

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
  const overlayInspectedId = graph.activeHoveredId ?? graph.pinnedSelectionId;
  const inspectedNode = graph.nodeMap.get(overlayInspectedId ?? "") ?? null;

  return (
    <Card className="overflow-hidden rounded-md border-border/70 bg-card/85 shadow-none">
      {!minimalChrome ? (
        <CardHeader className="space-y-3 border-b border-border/70 bg-background/25 pb-3">
          <p className="sr-only">
            Showing {graph.visibleNodeIds.size} of {graph.nodes.length} dependency-linked stablecoins with{" "}
            {graph.visibleLinks.length} visible edges.
          </p>
          <ContagionGraphHeader graph={graph} />
        </CardHeader>
      ) : null}
      <CardContent className="p-3 sm:p-4">
        <ContagionGraphStage
          graph={graph}
          logos={logos}
          nodeTooltipEl={nodeTooltipEl}
          edgeTooltipEl={edgeTooltipEl}
          overlay={
            <ContagionGraphInsights
              inspectedNode={inspectedNode}
              visibleLinks={graph.visibleLinks}
              nodeMap={graph.nodeMap}
              logos={logos}
              onTraceNode={graph.handleTraceNodeChange}
            />
          }
        />
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {tooltipAnnouncement}
        </div>
      </CardContent>
    </Card>
  );
}
