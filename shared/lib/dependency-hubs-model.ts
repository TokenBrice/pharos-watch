import type { ReportCardsV9DependencyEdge } from "../types/report-cards-v9";
import { buildDirectHubExposures, exposureKnown, mappedDependentSupply, type ExposureTotals, type HubExposure, type SupplyOf, type WrapperClaimForm } from "./dependency-exposure";
import { CLIENT_TRACKED_META_BY_ID } from "./stablecoins/client-registry";

export interface DependencyHubCard {
  id: string;
  name: string;
  symbol: string;
  isDefunct?: boolean;
  sharedBookId?: string | null;
}
export interface DependencyClaimAvailability {
  known: boolean;
  complete: boolean;
}
export interface DependencyWrapperSplit {
  unknownFormUsd: number | null;
  unknownFormCount: number;
  passThroughCount: number;
  vaultClaimCount: number;
  claimAvailability: Record<"pass-through" | "vault-claim" | "classified", DependencyClaimAvailability>;
}
export interface DependencyHubExposure extends HubExposure {
  directKnown: boolean;
}
export interface DependencyHub extends DependencyHubExposure, DependencyWrapperSplit {
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
  mappedSupply: ExposureTotals & DependencyWrapperSplit & { known: boolean; passThroughUsd: number; vaultClaimUsd: number };
  marketCapAsOf: number | null;
}

/**
 * A dependent's published wrapper form within one relationship set. Mechanism
 * claims publish a null wrapperForm by design, so they do not erase a sibling
 * wrapper claim's published form; a dependent with no published form, or with
 * conflicting published forms, stays unavailable. Hub rows classify only their
 * own edges, while the mapped total classifies the dependent once across parents.
 */
function resolveWrapperForm(
  relationships: readonly ReportCardsV9DependencyEdge[],
  id: string,
): WrapperClaimForm {
  let form: ReportCardsV9DependencyEdge["wrapperForm"];
  for (const edge of relationships) {
    if (edge.to !== id || edge.kind !== "serial" || edge.wrapperForm == null) continue;
    if (form !== undefined && form !== edge.wrapperForm) return "unknown";
    form = edge.wrapperForm;
  }
  return form == null ? "unknown" : form === "pure" || form === "native-staked" ? "pass-through" : "vault-claim";
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
    wrapperFormOf: (id: string): WrapperClaimForm => resolveWrapperForm(liveEdges, id),
  };
  // Serial supply is counted once per dependent, just like the exposure aggregates.
  // A missing published form is unavailable classification, not a zero-dollar category.
  const claimAvailability = (relationships: readonly ReportCardsV9DependencyEdge[], form: "pass-through" | "vault-claim" | "classified"): DependencyClaimAvailability => {
    const claims = relationships.filter(edge => edge.kind === "serial" && edge.wrapperForm != null
      && (form === "classified" || ((edge.wrapperForm === "pure" || edge.wrapperForm === "native-staked") === (form === "pass-through"))));
    return { known: claims.length === 0 || claims.some(edge => supplyOf(edge.to) !== null),
      complete: claims.every(edge => supplyOf(edge.to) !== null) };
  };
  const wrapperSplit = (relationships: readonly ReportCardsV9DependencyEdge[]) => {
    const split: DependencyWrapperSplit & { classifiedOwnFamilyUsd: number; passThroughUsd: number; vaultClaimUsd: number } = {
      unknownFormUsd: null, unknownFormCount: 0, passThroughCount: 0, vaultClaimCount: 0, classifiedOwnFamilyUsd: 0, passThroughUsd: 0, vaultClaimUsd: 0,
      claimAvailability: { "pass-through": claimAvailability(relationships, "pass-through"), "vault-claim": claimAvailability(relationships, "vault-claim"), classified: claimAvailability(relationships, "classified") } };
    const seen = new Set<string>();
    for (const edge of relationships) {
      if (edge.kind !== "serial" || seen.has(edge.to)) continue;
      seen.add(edge.to);
      const form = resolveWrapperForm(relationships, edge.to);
      const usd = supplyOf(edge.to)?.usd;
      if (form === "unknown") {
        split.unknownFormCount++;
        if (usd !== undefined) split.unknownFormUsd = (split.unknownFormUsd ?? 0) + usd;
      } else if (usd !== undefined) {
        if (form === "pass-through") {
          split.passThroughCount++;
          split.passThroughUsd += usd;
        } else {
          split.vaultClaimCount++;
          split.vaultClaimUsd += usd;
        }
        const family = opts.familyOf(edge.from);
        if (family !== null && family === opts.familyOf(edge.to)) split.classifiedOwnFamilyUsd += usd;
      }
    }
    return split;
  };
  const hubs = buildDirectHubExposures(liveEdges, supplyOf, opts).map(exposure => {
    const card = cardById.get(exposure.hubId)!;
    const hubEdges = liveEdges.filter(edge => edge.from === exposure.hubId);
    const serialCount = hubEdges.filter(edge => edge.kind === "serial").length;
    const split = wrapperSplit(hubEdges);
    return { ...exposure, ...split, ownFamilyUsd: split.classifiedOwnFamilyUsd, id: exposure.hubId, label: card.name, symbol: card.symbol,
      directKnown: exposureKnown(exposure.direct, hubEdges),
      hubMcapUsd: supplyOf(card.id)?.usd ?? null,
      topDependentSymbol: exposure.topDependent ? cardById.get(exposure.topDependent.id)?.symbol ?? exposure.topDependent.id : null,
      edgeTypeBreakdown: [
        ...(serialCount ? [{ type: "Wrapper" as const, edgeCount: serialCount }] : []),
        ...(hubEdges.length > serialCount ? [{ type: "Collateral" as const, edgeCount: hubEdges.length - serialCount }] : []),
      ],
    };
  });
  const mappedSupply = mappedDependentSupply(liveEdges, supplyOf, opts);
  return { hubs, upstreamHubCount: hubs.length, directEdgeCount: liveEdges.length,
    uniqueDirectDependentCount: new Set(liveEdges.map(edge => edge.to)).size,
    mappedSupply: { ...mappedSupply, ...wrapperSplit(liveEdges), known: exposureKnown(mappedSupply, liveEdges) }, marketCapAsOf };
}
