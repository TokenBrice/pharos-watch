import type { StablecoinMeta } from "@shared/types";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";

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

export function buildV9DependencyCoverageFacts(
  coins: readonly DependencyCoverageCoin[],
  reportCards: Pick<ReportCardsV9CurrentResponse, "cards" | "dependencyGraph">,
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
