import { filterDependencyGraphEdgesToLive, type DependencyGraphEdge } from "@shared/lib/dependency-graph";
import type { DependencyWeight, ReportCard, ReportCardsResponse, StablecoinMeta } from "@shared/types";

export type DependencyCoverageKind = "both" | "dependent" | "upstream" | "resolved-none" | "unmapped-gap";

export interface DependencyCoverageFact {
  kind: DependencyCoverageKind;
  upstreamCount: number;
  dependentCount: number;
  rawDependencyCount: number;
  mappedDependencyWeight: number;
  missingReportCard?: boolean;
}

type DependencyCoverageCoin = Pick<StablecoinMeta, "id" | "reserves" | "variantOf"> &
  Partial<Pick<StablecoinMeta, "dependencies">>;

function hasCuratedDependencyEvidence(coin: DependencyCoverageCoin): boolean {
  return (
    !!coin.variantOf ||
    (coin.dependencies?.length ?? 0) > 0 ||
    (coin.reserves?.some((reserve) => !!reserve.coinId) ?? false)
  );
}

function sumIncomingWeight(edges: readonly DependencyGraphEdge[], id: string): number {
  return edges.reduce((sum, edge) => sum + (edge.to === id ? edge.weight : 0), 0);
}

function hasUnmappedDependencyEvidence(
  coin: DependencyCoverageCoin,
  reportCard: ReportCard | undefined,
  rawDependencies: readonly DependencyWeight[],
): boolean {
  if (rawDependencies.length > 0) return true;
  if (reportCard?.rawInputs.dependencyFromLive) return false;
  return hasCuratedDependencyEvidence(coin);
}

export function buildDependencyCoverageFacts(
  coins: readonly DependencyCoverageCoin[],
  reportCards: Pick<ReportCardsResponse, "cards" | "dependencyGraph">,
): Map<string, DependencyCoverageFact> {
  const liveIds = new Set(reportCards.cards.filter((card) => !card.isDefunct).map((card) => card.id));
  const liveEdges = filterDependencyGraphEdgesToLive(reportCards.dependencyGraph?.edges ?? [], liveIds);
  const upstreamCountById = new Map<string, number>();
  const dependentCountById = new Map<string, number>();
  const reportCardById = new Map(reportCards.cards.map((card) => [card.id, card]));

  for (const edge of liveEdges) {
    upstreamCountById.set(edge.to, (upstreamCountById.get(edge.to) ?? 0) + 1);
    dependentCountById.set(edge.from, (dependentCountById.get(edge.from) ?? 0) + 1);
  }

  const facts = new Map<string, DependencyCoverageFact>();
  for (const coin of coins) {
    const reportCard = reportCardById.get(coin.id);
    const rawDependencies = reportCard?.rawInputs.dependencies ?? [];
    const upstreamCount = upstreamCountById.get(coin.id) ?? 0;
    const dependentCount = dependentCountById.get(coin.id) ?? 0;
    let kind: DependencyCoverageKind;

    if (!reportCard) {
      kind = "unmapped-gap";
    } else if (upstreamCount > 0 && dependentCount > 0) {
      kind = "both";
    } else if (upstreamCount > 0) {
      kind = "dependent";
    } else if (dependentCount > 0) {
      kind = "upstream";
    } else if (hasUnmappedDependencyEvidence(coin, reportCard, rawDependencies)) {
      kind = "unmapped-gap";
    } else {
      kind = "resolved-none";
    }

    facts.set(coin.id, {
      kind,
      upstreamCount,
      dependentCount,
      rawDependencyCount: rawDependencies.length,
      mappedDependencyWeight: sumIncomingWeight(liveEdges, coin.id),
      missingReportCard: !reportCard,
    });
  }

  return facts;
}
