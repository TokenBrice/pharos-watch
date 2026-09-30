"use client";

import { ContagionGraphBody } from "@/components/contagion-graph/contagion-graph-body";
import { ContagionGraphShell } from "@/components/contagion-graph/contagion-graph-shell";
import { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { ReactNode } from "react";
import type { HubExposure } from "@shared/lib/dependency-exposure";
import type { ExposureOverlay } from "@/components/contagion-graph/contagion-graph-exposure";

interface ContagionGraphProps {
  cards: readonly ContagionGraphCard[];
  dependencyEdges: readonly ReportCardsV9DependencyEdge[];
  mcapMap: ReadonlyMap<string, number | null>;
  logos?: Record<string, string>;
  focusCoinId?: string;
  minimalChrome?: boolean;
  maxNodes?: number;
  syncUrlState?: boolean;
  exposureOverlay?: ExposureOverlay | null;
  onUseAsExposureRoot?: (coinId: string) => void;
  hubExposures?: readonly HubExposure[];
  modeControls?: ReactNode;
}

export function ContagionGraph({
  cards,
  dependencyEdges,
  mcapMap,
  logos,
  focusCoinId,
  minimalChrome,
  maxNodes,
  syncUrlState = false,
  exposureOverlay,
  onUseAsExposureRoot,
  hubExposures,
  modeControls,
}: ContagionGraphProps) {
  const graph = useContagionGraphModel({ cards, dependencyEdges, mcapMap, focusCoinId, maxNodes, exposureOverlay, onUseAsExposureRoot, hubExposures, syncUrlState: syncUrlState && !minimalChrome, trackActions: !minimalChrome });


  const stage = graph.nodes.length > 0
    ? <ContagionGraphBody graph={graph} logos={logos} detailNodePresentation={Boolean(minimalChrome)} />
    : <p role="status" className="p-4 text-sm text-muted-foreground">No mapped graph nodes are available for this selection.</p>;

  if (minimalChrome) {
    return <div className="min-w-0 lg:h-full">{stage}</div>;
  }

  return <ContagionGraphShell graph={graph} stage={stage} modeControls={modeControls} />;
}
