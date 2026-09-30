import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import { buildDirectHubExposures, mappedDependentSupply, type ExposureTotals, type HubExposure, type SupplyOf, type WrapperClaimForm } from "@shared/lib/dependency-exposure";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

export interface DependencyHubCard {
  id: string;
  name: string;
  symbol: string;
  isDefunct?: boolean;
  sharedBookId?: string | null;
}
export interface DependencyHub extends HubExposure {
  id: string;
  label: string;
  symbol: string;
  hubMcapUsd: number | null;
  topDependentSymbol: string | null;
  edgeTypeBreakdown: { type: "Wrapper" | "Collateral"; edgeCount: number }[];
}
export interface DependencyHubsModel {
  hubs: DependencyHub[];
  upstreamHubCount: number;
  directEdgeCount: number;
  uniqueDirectDependentCount: number;
  mappedSupply: ExposureTotals & { passThroughUsd: number; vaultClaimUsd: number };
  marketCapAsOf: number | null;
}

export function buildDependencyHubsModel({ cards, edges, mcapMap, marketCapAsOf = null }: {
  cards: readonly DependencyHubCard[];
  edges: readonly ReportCardsV9DependencyEdge[];
  mcapMap: ReadonlyMap<string, number | null>;
  marketCapAsOf?: number | null;
}): DependencyHubsModel {
  const cardById = new Map(cards.filter(card => !card.isDefunct).map(card => [card.id, card]));
  const liveEdges = edges.filter(edge => cardById.has(edge.from) && cardById.has(edge.to));
  const supplyOf: SupplyOf = id => {
    const usd = mcapMap.get(id);
    return usd === undefined || usd === null || !Number.isFinite(usd) || usd < 0 ? null : { usd, asOf: marketCapAsOf, basis: "market-cap-proxy" };
  };
  const opts = {
    sharedBooks: {
      bookIdOf: (id: string) => cardById.get(id)?.sharedBookId ?? null,
      // The publication identifies books but does not yet publish measured holdings.
      measuredHoldingUsd: () => null,
    },
    familyOf: (id: string): string | null => {
      let current = id;
      for (let depth = 0; depth <= CLIENT_TRACKED_META_BY_ID.size; depth++) {
        const parent = CLIENT_TRACKED_META_BY_ID.get(current)?.variantOf;
        if (!parent) return current;
        current = parent;
      }
      return null;
    },
    wrapperFormOf: (id: string): WrapperClaimForm => {
      let form: ReportCardsV9DependencyEdge["wrapperForm"];
      for (const edge of liveEdges) {
        if (edge.to !== id || edge.kind !== "serial") continue;
        if (edge.wrapperForm == null || (form !== undefined && form !== edge.wrapperForm)) return "unknown";
        form = edge.wrapperForm;
      }
      return form == null ? "unknown" : form === "pure" || form === "native-staked" ? "pass-through" : "vault-claim";
    },
  };
  const hubs = buildDirectHubExposures(liveEdges, supplyOf, opts).map(exposure => {
    const card = cardById.get(exposure.hubId)!;
    const hubEdges = liveEdges.filter(edge => edge.from === exposure.hubId);
    const serialCount = hubEdges.filter(edge => edge.kind === "serial").length;
    return { ...exposure, id: exposure.hubId, label: card.name, symbol: card.symbol,
      hubMcapUsd: supplyOf(card.id)?.usd ?? null,
      topDependentSymbol: exposure.topDependent ? cardById.get(exposure.topDependent.id)?.symbol ?? exposure.topDependent.id : null,
      edgeTypeBreakdown: [
        ...(serialCount ? [{ type: "Wrapper" as const, edgeCount: serialCount }] : []),
        ...(hubEdges.length > serialCount ? [{ type: "Collateral" as const, edgeCount: hubEdges.length - serialCount }] : []),
      ],
    };
  });
  return { hubs, upstreamHubCount: hubs.length, directEdgeCount: liveEdges.length,
    uniqueDirectDependentCount: new Set(liveEdges.map(edge => edge.to)).size,
    mappedSupply: mappedDependentSupply(liveEdges, supplyOf, opts), marketCapAsOf };
}
