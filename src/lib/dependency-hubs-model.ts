import type { DependencyGraphEdge } from "@shared/lib/dependency-graph";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";

export interface DependencyHubCard {
  id: string;
  name: string;
  symbol: string;
  isDefunct?: boolean;
}

export interface DependencyHubExample {
  id: string;
  label: string;
  symbol: string;
  mcapUsd: number;
}

export interface DependencyHubEdgeTypeBreakdown {
  type: DependencyMateriality;
  edgeCount: number;
  summedDirectDependencyWeight: number;
}

export interface DependencyHub {
  id: string;
  label: string;
  symbol: string;
  dependentCount: number;
  summedDirectDependencyWeight: number;
  uniqueDependentMcapUsd: number;
  hubMcapUsd: number;
  examples: DependencyHubExample[];
  edgeTypeBreakdown: DependencyHubEdgeTypeBreakdown[];
}

export interface DependencyHubsModel {
  hubs: DependencyHub[];
  upstreamHubCount: number;
  directEdgeCount: number;
  uniqueDirectDependentCount: number;
  summedDirectDependencyWeight: number;
  uniqueDependentMcapUsd: number;
}

interface BuildDependencyHubsModelArgs {
  cards: readonly DependencyHubCard[];
  edges: readonly DependencyHubEdge[];
  mcapMap: ReadonlyMap<string, number>;
}

interface HubAccumulator {
  dependentIds: Set<string>;
  summedDirectDependencyWeight: number;
  typeBreakdown: Map<DependencyMateriality, DependencyHubEdgeTypeBreakdown>;
}

type V9DependencyEdge = ReportCardsV9Response["dependencyGraph"]["edges"][number];
type DependencyHubEdge = DependencyGraphEdge | V9DependencyEdge;
type DependencyMateriality = DependencyGraphEdge["type"] | V9DependencyEdge["materiality"];

function edgeWeight(edge: DependencyHubEdge): number {
  if ("kind" in edge) return edge.kind === "serial" ? 1 : edge.weight ?? 0;
  return edge.weight;
}

function edgeMateriality(edge: DependencyHubEdge): DependencyMateriality {
  return "materiality" in edge ? edge.materiality : edge.type;
}

function compareDependencyExamples(a: DependencyHubExample, b: DependencyHubExample): number {
  if (b.mcapUsd !== a.mcapUsd) return b.mcapUsd - a.mcapUsd;
  if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
  return a.label.localeCompare(b.label);
}

function compareDependencyHubs(a: DependencyHub, b: DependencyHub): number {
  if (b.dependentCount !== a.dependentCount) return b.dependentCount - a.dependentCount;
  if (b.summedDirectDependencyWeight !== a.summedDirectDependencyWeight) {
    return b.summedDirectDependencyWeight - a.summedDirectDependencyWeight;
  }
  if (b.uniqueDependentMcapUsd !== a.uniqueDependentMcapUsd) {
    return b.uniqueDependentMcapUsd - a.uniqueDependentMcapUsd;
  }
  if (b.hubMcapUsd !== a.hubMcapUsd) return b.hubMcapUsd - a.hubMcapUsd;
  return a.label.localeCompare(b.label);
}

function getFiniteMcap(mcapMap: ReadonlyMap<string, number>, id: string): number {
  const value = mcapMap.get(id);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildDependencyHubsModel({
  cards,
  edges,
  mcapMap,
}: BuildDependencyHubsModelArgs): DependencyHubsModel {
  const liveCards = cards.filter((card) => !card.isDefunct);
  const liveIds = new Set(liveCards.map((card) => card.id));
  const cardById = new Map(liveCards.map((card) => [card.id, card]));
  const liveEdges = edges.filter((edge) => liveIds.has(edge.from) && liveIds.has(edge.to));
  const hubMap = new Map<string, HubAccumulator>();
  const allDependentIds = new Set<string>();

  for (const edge of liveEdges) {
    const hub = hubMap.get(edge.from) ?? {
      dependentIds: new Set<string>(),
      summedDirectDependencyWeight: 0,
      typeBreakdown: new Map<DependencyMateriality, DependencyHubEdgeTypeBreakdown>(),
    };
    const edgeType = edgeMateriality(edge);
    const weight = edgeWeight(edge);
    const breakdown = hub.typeBreakdown.get(edgeType) ?? {
      type: edgeType,
      edgeCount: 0,
      summedDirectDependencyWeight: 0,
    };

    hub.dependentIds.add(edge.to);
    hub.summedDirectDependencyWeight += weight;
    breakdown.edgeCount += 1;
    breakdown.summedDirectDependencyWeight += weight;
    hub.typeBreakdown.set(edgeType, breakdown);
    hubMap.set(edge.from, hub);
    allDependentIds.add(edge.to);
  }

  const hubs = [...hubMap.entries()]
    .map(([id, hub]) => {
      const hubCard = cardById.get(id);
      const dependentIds = [...hub.dependentIds];
      const examples = dependentIds
        .map((dependentId): DependencyHubExample | null => {
          const dependentCard = cardById.get(dependentId);
          if (!dependentCard) return null;
          return {
            id: dependentCard.id,
            label: dependentCard.name ?? dependentCard.symbol ?? dependentCard.id,
            symbol: dependentCard.symbol ?? dependentCard.id,
            mcapUsd: getFiniteMcap(mcapMap, dependentCard.id),
          };
        })
        .filter((example): example is DependencyHubExample => example !== null)
        .sort(compareDependencyExamples)
        .slice(0, 3);
      const uniqueDependentMcapUsd = dependentIds.reduce(
        (sum, dependentId) => sum + getFiniteMcap(mcapMap, dependentId),
        0,
      );
      const edgeTypeBreakdown = [...hub.typeBreakdown.values()].sort((a, b) => a.type.localeCompare(b.type));

      return {
        id,
        label: hubCard?.name ?? hubCard?.symbol ?? id,
        symbol: hubCard?.symbol ?? id,
        dependentCount: dependentIds.length,
        summedDirectDependencyWeight: hub.summedDirectDependencyWeight,
        uniqueDependentMcapUsd,
        hubMcapUsd: getFiniteMcap(mcapMap, id),
        examples,
        edgeTypeBreakdown,
      };
    })
    .sort(compareDependencyHubs);

  const uniqueDependentMcapUsd = [...allDependentIds].reduce(
    (sum, dependentId) => sum + getFiniteMcap(mcapMap, dependentId),
    0,
  );

  return {
    hubs,
    upstreamHubCount: hubs.length,
    directEdgeCount: liveEdges.length,
    uniqueDirectDependentCount: allDependentIds.size,
    summedDirectDependencyWeight: liveEdges.reduce((sum, edge) => sum + edgeWeight(edge), 0),
    uniqueDependentMcapUsd,
  };
}
