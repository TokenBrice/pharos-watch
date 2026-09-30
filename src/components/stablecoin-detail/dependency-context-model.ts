import { buildDirectHubExposures, type HubExposure, type SupplyOf } from "@shared/lib/dependency-exposure";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import type { PublishedCollateralUsageEntry } from "./collateral-usage-section";

export interface DetailDependencyContext {
  exposure: HubExposure | undefined;
  upstreams: PublishedCollateralUsageEntry[];
}

export function buildDetailDependencyContext(
  stablecoinId: string,
  cards: readonly SafetyScoreV9CurrentCard[],
  publishedEdges: readonly ReportCardsV9DependencyEdge[],
  mcapMap: ReadonlyMap<string, number | null>,
  marketCapAsOf: number | null,
): DetailDependencyContext {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const edges = publishedEdges.filter((edge) => cardById.has(edge.from) && cardById.has(edge.to));
  const supplyOf: SupplyOf = (id) => {
    const usd = mcapMap.get(id);
    return usd === undefined || usd === null || !Number.isFinite(usd) || usd < 0
      ? null : { usd, asOf: marketCapAsOf, basis: "market-cap-proxy" };
  };
  const exposure = buildDirectHubExposures(edges, supplyOf, {
    sharedBooks: {
      bookIdOf: (id) => cardById.get(id)?.sharedBookId ?? null,
      // The publication names shared books but does not publish measured holdings.
      measuredHoldingUsd: () => null,
    },
    familyOf: () => null,
    wrapperFormOf: () => "unknown",
  }).find((hub) => hub.hubId === stablecoinId);
  const upstreams: PublishedCollateralUsageEntry[] = edges.filter((edge) => edge.to === stablecoinId).map((edge) => {
    const upstream = CLIENT_TRACKED_META_BY_ID.get(edge.from);
    const dependent = CLIENT_TRACKED_META_BY_ID.get(edge.to);
    return {
      coin: { id: edge.from, name: upstream?.name ?? edge.from, symbol: upstream?.symbol ?? edge.from },
      edgeType: edge.kind,
      relationshipType: edge.dependencyType ?? (edge.kind === "basket" ? "collateral"
        : dependent?.variantOf === edge.from ? "wrapper" : "serial-claim"),
      weight: edge.weight,
      marketCap: mcapMap.get(edge.from) ?? null,
    };
  });
  return { exposure, upstreams };
}
