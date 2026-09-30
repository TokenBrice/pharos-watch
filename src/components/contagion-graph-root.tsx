"use client";

import { ContagionGraphBody } from "@/components/contagion-graph/contagion-graph-body";
import { ContagionGraphShell } from "@/components/contagion-graph/contagion-graph-shell";
import { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

interface ContagionGraphProps {
  cards: readonly ContagionGraphCard[];
  dependencyEdges: readonly ReportCardsV9DependencyEdge[];
  mcapMap: ReadonlyMap<string, number | null>;
  logos?: Record<string, string>;
  focusCoinId?: string;
  minimalChrome?: boolean;
  maxNodes?: number;
  syncUrlState?: boolean;
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
}: ContagionGraphProps) {
  const graph = useContagionGraphModel({ cards, dependencyEdges, mcapMap, focusCoinId, maxNodes, syncUrlState: syncUrlState && !minimalChrome, trackActions: !minimalChrome });

  if (graph.nodes.length === 0) return null;

  const stage = <ContagionGraphBody graph={graph} logos={logos} detailNodePresentation={Boolean(minimalChrome)} />;

  if (minimalChrome) {
    return <div className="min-w-0 lg:h-full">{stage}</div>;
  }

  return <ContagionGraphShell graph={graph} stage={stage} />;
}
