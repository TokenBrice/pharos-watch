"use client";

import { ContagionGraphBody } from "@/components/contagion-graph/contagion-graph-body";
import { ContagionGraphShell } from "@/components/contagion-graph/contagion-graph-shell";
import { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import type { ReportCard, ReportCardsResponse } from "@shared/types";

interface ContagionGraphProps {
  cards: ReportCard[];
  dependencyEdges?: ReportCardsResponse["dependencyGraph"]["edges"];
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
  focusCoinId?: string;
  minimalChrome?: boolean;
  maxNodes?: number;
  fullscreenMode?: boolean;
  showFullscreenControl?: boolean;
}

export function ContagionGraph({
  cards,
  dependencyEdges,
  mcapMap,
  logos,
  focusCoinId,
  minimalChrome,
  maxNodes,
  fullscreenMode = false,
  showFullscreenControl = true,
}: ContagionGraphProps) {
  const graph = useContagionGraphModel({ cards, dependencyEdges, mcapMap, focusCoinId, maxNodes });

  if (graph.nodes.length === 0) return null;

  const stage = (
    <ContagionGraphBody
      cards={cards}
      graph={graph}
      logos={logos}
      detailNodePresentation={Boolean(minimalChrome)}
    />
  );

  if (minimalChrome) {
    // lg:h-full lets the stage stretch to the Dependency Context split's row
    // height instead of leaving dead space under the aspect-sized canvas.
    return <div className="min-w-0 lg:h-full">{stage}</div>;
  }

  return (
    <ContagionGraphShell
      fullscreenGraph={
        <ContagionGraph
          cards={cards}
          dependencyEdges={dependencyEdges}
          mcapMap={mcapMap}
          logos={logos}
          focusCoinId={focusCoinId}
          maxNodes={maxNodes}
          fullscreenMode
          showFullscreenControl={false}
        />
      }
      fullscreenMode={fullscreenMode}
      graph={graph}
      showFullscreenControl={showFullscreenControl}
      stage={stage}
    />
  );
}
