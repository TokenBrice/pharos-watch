"use client";

import { ContagionGraphInsights } from "@/components/contagion-graph/contagion-graph-insights";
import { ContagionGraphStage } from "@/components/contagion-graph/contagion-graph-stage";
import type { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import {
  buildEdgeTooltipElement,
  buildNodeTooltipElement,
  buildTooltipAnnouncement,
} from "@/components/contagion-graph-tooltips";
import { HEIGHT, PAD, WIDTH } from "@/lib/contagion-layout";

interface ContagionGraphBodyProps {
  graph: ReturnType<typeof useContagionGraphModel>;
  logos?: Record<string, string>;
  detailNodePresentation?: boolean;
}

export function ContagionGraphBody({ graph, logos, detailNodePresentation }: ContagionGraphBodyProps) {
  const tooltipContext = {
    activeHoveredId: graph.activeHoveredId,
    activeHoveredEdge: graph.activeHoveredEdge,
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
  const mobileInspectedNode = graph.nodeMap.get(graph.pinnedSelectionId ?? graph.activeHoveredId ?? "") ?? null;

  return (
    <>
      <ContagionGraphStage
        graph={graph}
        logos={logos}
        detailNodePresentation={detailNodePresentation}
        nodeTooltipEl={nodeTooltipEl}
        edgeTooltipEl={edgeTooltipEl}
        overlay={
          <ContagionGraphInsights
            inspectedNode={inspectedNode}
            visibleLinks={graph.visibleLinks}
            nodeMap={graph.nodeMap}
            logos={logos}
            onTraceNode={graph.handleTraceNodeChange}
            variant="overlay"
          />
        }
      />
      <div className="border-x border-b px-3 py-2 sm:hidden" style={{ borderColor: "var(--graph-grid-line)" }}>
        {mobileInspectedNode ? (
          <ContagionGraphInsights
            inspectedNode={mobileInspectedNode}
            visibleLinks={graph.visibleLinks}
            nodeMap={graph.nodeMap}
            logos={logos}
            onTraceNode={graph.handleTraceNodeChange}
            variant="panel"
          />
        ) : (
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Tap a node to inspect dependencies. Use fullscreen for a larger touch canvas.
          </p>
        )}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {tooltipAnnouncement}
      </div>
    </>
  );
}
