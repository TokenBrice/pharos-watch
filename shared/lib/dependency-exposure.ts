import type { ReportCardsV9DependencyEdge } from "../types/report-cards-v9";

export type SupplyOf = (id: string) => { usd: number; asOf: number | null; basis: "market-cap-proxy" | "publication-circulating" } | null;
export interface ExposureTotals {
  knownUsd: number;
  excludedSupplyUnknownIds: string[];
  unknownShareEdgeCount: number;
  complete: boolean;
  overlapUsd: number;
  integrityFlag: boolean;
}
export interface SharedBookIndex {
  bookIdOf(coinId: string): string | null;
  measuredHoldingUsd(bookId: string, upstreamId: string): number | null;
}
export type WrapperClaimForm = "pass-through" | "vault-claim" | "unknown";
export interface ExposureOptions {
  sharedBooks: SharedBookIndex;
  familyOf(id: string): string | null;
  wrapperFormOf(id: string): WrapperClaimForm;
}
export interface HubExposure {
  hubId: string;
  direct: ExposureTotals;
  passThroughUsd: number;
  vaultClaimUsd: number;
  ownFamilyUsd: number;
  dependentCount: number;
  topDependent: { id: string; shareOfHubExposure: number } | null;
}

export function edgeShare(edge: ReportCardsV9DependencyEdge): number | null {
  return edge.kind === "serial" ? 1 : edge.weight;
}
export function v9DependencyEdgeWeight(edge: ReportCardsV9DependencyEdge): number | null {
  return edgeShare(edge);
}
export function v9DependencyEdgeScoreKnown(edge: ReportCardsV9DependencyEdge): boolean {
  return edge.materiality === "serial" || edge.materiality === "basket-weighted";
}
function totals(): ExposureTotals {
  return { knownUsd: 0, excludedSupplyUnknownIds: [], unknownShareEdgeCount: 0, complete: true, overlapUsd: 0, integrityFlag: false };
}
function byDependent(edges: readonly ReportCardsV9DependencyEdge[]) {
  const groups = new Map<string, ReportCardsV9DependencyEdge[]>();
  for (const edge of edges) {
    const group = groups.get(edge.to);
    if (group) group.push(edge); else groups.set(edge.to, [edge]);
  }
  return groups;
}
function mappedShare(edges: readonly ReportCardsV9DependencyEdge[]): number {
  if (edges.some(edge => edge.kind === "serial")) return 1;
  // Invalid published shares remain visible as invalid statistics, never silently capped.
  return edges.reduce((sum, edge) => edge.weight === null ? sum : sum + edge.weight, 0);
}
function invalidBasket(edges: readonly ReportCardsV9DependencyEdge[]): boolean {
  return edges.reduce((sum, edge) => edge.kind === "basket" && edge.weight !== null ? sum + edge.weight : sum, 0) > 1.000001;
}

export function buildDirectHubExposures(edges: readonly ReportCardsV9DependencyEdge[], supplyOf: SupplyOf, opts: ExposureOptions): HubExposure[] {
  const dependents = byDependent(edges);
  const byHub = new Map<string, ReportCardsV9DependencyEdge[]>();
  for (const edge of edges) {
    const group = byHub.get(edge.from);
    if (group) group.push(edge); else byHub.set(edge.from, [edge]);
  }
  return [...byHub].map(([hubId, hubEdges]) => {
    const direct = totals();
    const amounts = new Map<string, number>();
    const books = new Map<string, number>();
    let passThroughUsd = 0, vaultClaimUsd = 0, ownFamilyUsd = 0;
    for (const [id, group] of byDependent(hubEdges)) {
      direct.unknownShareEdgeCount += group.filter(edge => edgeShare(edge) === null).length;
      direct.integrityFlag ||= invalidBasket(dependents.get(id)!);
      const supply = supplyOf(id);
      if (!supply) { direct.excludedSupplyUnknownIds.push(id); continue; }
      const amount = supply.usd * mappedShare(group);
      amounts.set(id, amount);
      const book = opts.sharedBooks.bookIdOf(id);
      if (book && group.every(edge => edge.kind === "basket")) books.set(book, (books.get(book) ?? 0) + amount);
      else direct.knownUsd += amount;
      const upstreamEdges = dependents.get(hubId);
      if (upstreamEdges && (!book || group.some(edge => edge.kind === "serial"))) direct.overlapUsd += amount * mappedShare(upstreamEdges);
      if (group.some(edge => edge.kind === "serial")) {
        const form = opts.wrapperFormOf(id);
        if (form === "pass-through") passThroughUsd += amount;
        if (form === "vault-claim") vaultClaimUsd += amount;
        const family = opts.familyOf(hubId);
        if (family !== null && family === opts.familyOf(id)) ownFamilyUsd += amount;
      }
    }
    for (const [book, amount] of books) {
      const holdingUsd = opts.sharedBooks.measuredHoldingUsd(book, hubId) ?? amount;
      direct.knownUsd += holdingUsd;
      const upstreamEdges = dependents.get(hubId);
      if (upstreamEdges) direct.overlapUsd += holdingUsd * mappedShare(upstreamEdges);
    }
    direct.excludedSupplyUnknownIds.sort();
    direct.complete = direct.excludedSupplyUnknownIds.length === 0 && direct.unknownShareEdgeCount === 0 && !direct.integrityFlag;
    const top = [...amounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return { hubId, direct, passThroughUsd, vaultClaimUsd, ownFamilyUsd, dependentCount: byDependent(hubEdges).size,
      topDependent: top && direct.knownUsd > 0 ? { id: top[0], shareOfHubExposure: top[1] / direct.knownUsd } : null };
  }).sort((a, b) => b.direct.knownUsd - a.direct.knownUsd || b.dependentCount - a.dependentCount || a.hubId.localeCompare(b.hubId));
}

export function mappedDependentSupply(edges: readonly ReportCardsV9DependencyEdge[], supplyOf: SupplyOf, opts: ExposureOptions): ExposureTotals & { passThroughUsd: number; vaultClaimUsd: number } {
  const result = { ...totals(), passThroughUsd: 0, vaultClaimUsd: 0 };
  const groups = byDependent(edges);
  const books = new Map<string, Map<string, number>>();
  for (const [id, group] of groups) {
    result.unknownShareEdgeCount += group.filter(edge => edgeShare(edge) === null).length;
    result.integrityFlag ||= invalidBasket(group);
    const supply = supplyOf(id);
    if (!supply) { result.excludedSupplyUnknownIds.push(id); continue; }
    const amount = supply.usd * mappedShare(group);
    const book = opts.sharedBooks.bookIdOf(id);
    if (book && group.every(edge => edge.kind === "basket")) {
      let holdings = books.get(book);
      if (!holdings) {
        holdings = new Map<string, number>();
        books.set(book, holdings);
      }
      for (const edge of group) {
        if (edge.weight === null) continue;
        holdings.set(edge.from, (holdings.get(edge.from) ?? 0) + supply.usd * edge.weight);
      }
    } else result.knownUsd += amount;
    // Only the upstream's mapped fraction is counted again in another layer.
    let serialOverlap = 0, basketOverlap = 0;
    for (const edge of group) {
      const upstreamEdges = groups.get(edge.from);
      if (!upstreamEdges) continue;
      const upstreamShare = mappedShare(upstreamEdges);
      if (edge.kind === "serial") serialOverlap = Math.max(serialOverlap, upstreamShare);
      else if (edge.weight !== null) basketOverlap += edge.weight * upstreamShare;
    }
    if (!book || group.some(edge => edge.kind === "serial")) {
      result.overlapUsd += supply.usd * Math.max(serialOverlap, basketOverlap);
    }
    if (group.some(edge => edge.kind === "serial")) {
      const form = opts.wrapperFormOf(id);
      if (form === "pass-through") result.passThroughUsd += amount;
      if (form === "vault-claim") result.vaultClaimUsd += amount;
    }
  }
  for (const [book, holdings] of books) {
    for (const [upstreamId, fallbackUsd] of holdings) {
      const holdingUsd = opts.sharedBooks.measuredHoldingUsd(book, upstreamId) ?? fallbackUsd;
      result.knownUsd += holdingUsd;
      const upstreamEdges = groups.get(upstreamId);
      if (upstreamEdges) result.overlapUsd += holdingUsd * mappedShare(upstreamEdges);
    }
  }
  result.excludedSupplyUnknownIds.sort();
  result.complete = result.excludedSupplyUnknownIds.length === 0 && result.unknownShareEdgeCount === 0 && !result.integrityFlag;
  return result;
}
