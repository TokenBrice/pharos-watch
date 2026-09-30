import type { StablecoinClientListMeta } from "@shared/types/stablecoin-client-meta";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";

export type DependencyCoverageKind = "both" | "dependent" | "upstream" | "resolved-none" | "unmapped-gap";

export interface DependencyCoverageFact {
  kind: DependencyCoverageKind;
  upstreamCount: number;
  dependentCount: number;
  dependencyCoverageReasons?: readonly string[];
}

type DependencyCoverageCoin = Pick<StablecoinClientListMeta, "id" | "hasAuthoredDependencyEvidence">;

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

  for (const edge of edges) {
    upstreamCountById.set(edge.to, (upstreamCountById.get(edge.to) ?? 0) + 1);
    dependentCountById.set(edge.from, (dependentCountById.get(edge.from) ?? 0) + 1);
  }

  return new Map(coins.map((coin) => {
    const card = cardById.get(coin.id);
    const upstreamCount = upstreamCountById.get(coin.id) ?? 0;
    const dependentCount = dependentCountById.get(coin.id) ?? 0;
    const dependencyCoverageReasons = card?.dependencyCoverage?.map((row) => row.reason) ?? [];
    const kind: DependencyCoverageKind = !card
      ? "unmapped-gap"
      : upstreamCount > 0 && dependentCount > 0
        ? "both"
        : upstreamCount > 0
          ? "dependent"
          : dependentCount > 0
            ? "upstream"
            : coin.hasAuthoredDependencyEvidence || dependencyCoverageReasons.length > 0
              ? "unmapped-gap"
              : "resolved-none";
    return [coin.id, {
      kind,
      upstreamCount,
      dependentCount,
      dependencyCoverageReasons,
    }];
  }));
}
