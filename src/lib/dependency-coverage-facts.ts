import { filterDependencyGraphEdgesToLive, type DependencyGraphEdge } from "@shared/lib/dependency-graph";
import type { DependencyWeight, ReportCard, ReportCardsResponse, StablecoinMeta } from "@shared/types";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";

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

export function buildV9DependencyCoverageFacts(
  coins: readonly DependencyCoverageCoin[],
  reportCards: Pick<ReportCardsV9Response, "cards" | "dependencyGraph">,
): Map<string, DependencyCoverageFact> {
  const cardById = new Map(reportCards.cards.map((card) => [card.id, card]));
  const liveIds = new Set(cardById.keys());
  const edges = reportCards.dependencyGraph.edges.filter(
    (edge) => liveIds.has(edge.from) && liveIds.has(edge.to),
  );
  const upstreamCountById = new Map<string, number>();
  const dependentCountById = new Map<string, number>();
  const mappedWeightById = new Map<string, number>();

  for (const edge of edges) {
    upstreamCountById.set(edge.to, (upstreamCountById.get(edge.to) ?? 0) + 1);
    dependentCountById.set(edge.from, (dependentCountById.get(edge.from) ?? 0) + 1);
    mappedWeightById.set(
      edge.to,
      (mappedWeightById.get(edge.to) ?? 0) + (edge.kind === "serial" ? 1 : edge.weight ?? 0),
    );
  }

  return new Map(coins.map((coin) => {
    const card = cardById.get(coin.id);
    const upstreamCount = upstreamCountById.get(coin.id) ?? 0;
    const dependentCount = dependentCountById.get(coin.id) ?? 0;
    const rawDependencyCount = card
      ? card.dependencies.serial.length + card.dependencies.basket.length
      : 0;
    const kind: DependencyCoverageKind = !card
      ? "unmapped-gap"
      : upstreamCount > 0 && dependentCount > 0
        ? "both"
        : upstreamCount > 0
          ? "dependent"
          : dependentCount > 0
            ? "upstream"
            : rawDependencyCount > 0 || hasCuratedDependencyEvidence(coin)
              ? "unmapped-gap"
              : "resolved-none";
    return [coin.id, {
      kind,
      upstreamCount,
      dependentCount,
      rawDependencyCount,
      mappedDependencyWeight: mappedWeightById.get(coin.id) ?? 0,
      missingReportCard: !card,
    }];
  }));
}
