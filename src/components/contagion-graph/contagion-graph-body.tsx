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
import { graphNodeLabel } from "@/components/contagion-graph-model";

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
      {graph.exposureOverlay && (
        <p className="px-3 py-2 text-xs" role="status">
          Showing {Array.from(graph.exposureOverlay.rows.keys()).filter(id => graph.visibleNodeIds.has(id)).length} of {graph.exposureOverlay.rows.size} linked coins
        </p>
      )}
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
            fullLinks={graph.fullResolvedLinks}
            directExposureById={graph.directExposureById}
            nodeMap={graph.nodeMap}
            logos={logos}
            onTraceNode={graph.handleTraceNodeChange}
            onUseAsExposureRoot={graph.onUseAsExposureRoot}
            variant="overlay"
          />
        }
      />
      <div className="border-x border-b px-3 py-2 sm:hidden" style={{ borderColor: "var(--graph-grid-line)" }}>
        {mobileInspectedNode ? (
          <ContagionGraphInsights
            inspectedNode={mobileInspectedNode}
            visibleLinks={graph.visibleLinks}
            fullLinks={graph.fullResolvedLinks}
            directExposureById={graph.directExposureById}
            nodeMap={graph.nodeMap}
            logos={logos}
            onTraceNode={graph.handleTraceNodeChange}
            onUseAsExposureRoot={graph.onUseAsExposureRoot}
            variant="panel"
          />
        ) : (
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Tap a node to inspect dependencies.{!detailNodePresentation && " Use fullscreen for a larger touch canvas."}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs">
        {graph.smallLinkCount > 0 && (
          <button
            type="button"
            className="pharos-focus-ring min-h-11 rounded-sm border px-2 py-1"
            aria-pressed={graph.showSmallLinks}
            onClick={() => graph.setShowSmallLinks(value => !value)}
          >
            {graph.showSmallLinks ? `Hide ${graph.smallLinkCount} small links` : `${graph.smallLinkCount} small links hidden. Show small links`}
          </button>
        )}
        <label className="flex items-center gap-2">
          Inspect dependency
          <select
            className="pharos-focus-ring min-h-11 min-w-0 rounded-sm border bg-background px-2 py-1"
            value={graph.activeHoveredEdge ?? ""}
            onChange={event => {
              graph.handleNodeMouseLeave();
              if (event.target.value === "") graph.handleEdgeMouseLeave();
              else graph.handleEdgeMouseEnter(Number(event.target.value));
            }}
          >
            <option value="">Choose a connection</option>
            {graph.visibleLinks.map(link => (
              <option key={link.index} value={link.index}>
                {graphNodeLabel(graph.nodeMap.get(link.srcId) ?? { id: link.srcId, symbol: link.srcId })} depends on {graphNodeLabel(graph.nodeMap.get(link.tgtId) ?? { id: link.tgtId, symbol: link.tgtId })}
                {link.scoreKnown === false ? " (upstream not rateable)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="sr-only" aria-label="Dependency inspection announcements" aria-live="polite" aria-atomic="true">
        {tooltipAnnouncement}
      </div>
      <div className="sr-only" aria-label="Graph filter announcements" aria-live="polite" aria-atomic="true">
        {`Filter results: ${graph.visibleNodeIds.size} stablecoins and ${graph.visibleLinks.length} connections. Focus ${graph.focusMode}, type ${graph.edgeTypeFilter}, limit ${graph.effectiveNodeLimit}. ${graph.showSmallLinks ? 0 : graph.smallLinkCount} small links hidden.`}
      </div>
    </>
  );
}
