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
  // Sparse neighborhoods scale nodes up so the canvas is not mostly empty, but the
  // ceiling stays low because token logos are 50px raster sources — see
  // MAX_RASTER_LOGO_RADIUS in contagion-graph-svg.tsx.
  const detailNodeScale = detailNodePresentation
    ? graph.visibleNodeIds.size <= 5
      ? 2
      : graph.visibleNodeIds.size <= 10
        ? 1.5
        : 1
    : 1;
  return (
    <div
      className={
        detailNodePresentation
          ? "relative w-full overflow-hidden rounded-sm border lg:h-full"
          : // Map-page variant: the canvas sits inside the map card, so it drops
            // its own border (no nested panel chrome) — the tinted grid surface
            // self-delineates. Detail-page snapshots keep the frame.
            "relative w-full overflow-hidden rounded-sm"
      }
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
        graph={graph}
        logos={logos}
        logoZoom={detailNodePresentation && detailNodeScale === 1 ? 1.33 : 1}
        nodeScale={detailNodeScale}
        suppressHubLabels={Boolean(detailNodePresentation)}
        showTickerLabels={showTickerLabels}
        fillHeight={Boolean(detailNodePresentation)}
        nodeTooltipEl={nodeTooltipEl}
        edgeTooltipEl={edgeTooltipEl}
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
