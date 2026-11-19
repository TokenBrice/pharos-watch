import type { ReportCardsV9DependencyEdge } from "../types/report-cards-v9";
import { V9_CANDIDATE_POLICY_V1 } from "./safety-score-v9/policy";
import { stronglyConnectedComponents } from "./strongly-connected-components";

export type SupplyOf = (id: string) => { usd: number; asOf: number | null; basis: "market-cap-proxy" | "publication-circulating" } | null;
export interface ExposureTotals {
  knownUsd: number;
  excludedSupplyUnknownIds: string[];
  unknownShareEdgeCount: number;
  complete: boolean;
  hasKnownUsd?: boolean;
  /** Known overlap subtotal. Footprints expose the full bound and its availability separately. */
  overlapUsd: number;
  overlapUpperBoundUsd?: number | null;
  overlapUnavailableReason?: "shared-book-claims-unmatched" | "serial-parent-attribution-ambiguous";
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

/** Empty sets and measured contributions (including zero) are known; all-unknown sets are not. */
export function exposureKnown(totals: ExposureTotals, edges: readonly ReportCardsV9DependencyEdge[]): boolean {
  const excluded = new Set(totals.excludedSupplyUnknownIds);
  return totals.knownUsd > 0 || edges.length === 0
    || edges.some(edge => !excluded.has(edge.to) && edgeShare(edge) !== null);
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
  const basketWeight = edges.reduce((sum, edge) => edge.kind === "basket" && edge.weight !== null ? sum + edge.weight : sum, 0);
  // Invalid published shares remain visible as invalid statistics, never silently capped.
  return edges.some(edge => edge.kind === "serial") ? Math.max(1, basketWeight) : basketWeight;
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

export interface LookThroughShare {
  share: number | null;
  minHop: number;
  integrityFlag: boolean;
}

export function lookThroughShares(
  roots: readonly string[],
  edges: readonly ReportCardsV9DependencyEdge[],
): Map<string, LookThroughShare> {
  const rootSet = new Set(roots);
  const outgoing = new Map<string, ReportCardsV9DependencyEdge[]>();
  for (const edge of edges) {
    const group = outgoing.get(edge.from);
    if (group) group.push(edge); else outgoing.set(edge.from, [edge]);
  }
  const hops = new Map(roots.map(id => [id, 0]));
  const queue = [...hops.keys()];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const edge of outgoing.get(id) ?? []) {
      if (hops.has(edge.to)) continue;
      hops.set(edge.to, hops.get(id)! + 1);
      queue.push(edge.to);
    }
  }

  // SCCs identify cycle members, not the acyclic descendants blocked by them.
  const cyclic = new Set<string>();
  for (const members of stronglyConnectedComponents(queue, function* (id) {
    for (const edge of outgoing.get(id) ?? []) yield edge.to;
  })) {
    if (members.length > 1 || (outgoing.get(members[0]) ?? []).some(edge => edge.to === members[0])) {
      for (const member of members) cyclic.add(member);
    }
  }

  const incoming = byDependent(edges);
  const values = new Map<string, LookThroughShare>();
  const pending = new Map<string, number>();
  const ready: string[] = [];
  for (const id of queue) {
    if (cyclic.has(id) || rootSet.has(id)) {
      values.set(id, { share: cyclic.has(id) ? null : 1, minHop: hops.get(id)!, integrityFlag: cyclic.has(id) });
    } else {
      const count = (incoming.get(id) ?? []).filter(edge => hops.has(edge.from) && !rootSet.has(edge.from) && !cyclic.has(edge.from)).length;
      pending.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i], group = incoming.get(id) ?? [];
    // Only a predecessor the roots actually reach contributes to this
    // dependent's verdict; an outside malformed row is quarantined on its own,
    // not against a healthy neighbour (ADR-35).
    const reachedGroup = group.filter(edge => hops.has(edge.from));
    let serialTerm = 0, basketTerm = 0;
    let unknown = reachedGroup.some(edge => edgeShare(edge) === null);
    let integrityFlag = invalidBasket(reachedGroup) || unknown;
    for (const edge of group) {
      const upstream = values.get(edge.from);
      if (!upstream) continue;
      integrityFlag ||= upstream.integrityFlag;
      const weight = edgeShare(edge);
      if (weight === null) { integrityFlag = true; continue; }
      if (weight === 0) continue;
      if (upstream.share === null) { unknown = true; continue; }
      if (edge.kind === "serial") serialTerm = Math.max(serialTerm, upstream.share);
      else basketTerm += weight * upstream.share;
    }
    integrityFlag ||= basketTerm > 1.000001;
    values.set(id, { share: unknown ? null : Math.max(serialTerm, basketTerm), minHop: hops.get(id)!, integrityFlag });
    for (const edge of outgoing.get(id) ?? []) {
      const count = pending.get(edge.to);
      if (count === undefined) continue;
      pending.set(edge.to, count - 1);
      if (count === 1) ready.push(edge.to);
    }
  }
  for (const root of roots) values.delete(root);
  return values;
}

export type ExposureBand = "material" | "minor" | "trace" | "unknown";
interface ExposureRow {
  id: string;
  minHop: number;
  share: number | null;
  band: ExposureBand;
  exposureUsd: number | null;
  scoreUnknown: boolean;
  paths: string[][];
}

type FootprintTotals = ExposureTotals & { hasKnownUsd: boolean; overlapUpperBoundUsd: number | null };
type BookMember = { id: string; usd: number | null };

// Keep only k candidates per vertex in a max-heap. This bounds work even when
// the graph has exponentially many simple paths; cycles never revisit a vertex.
function topExposurePaths(roots: readonly string[], edges: readonly ReportCardsV9DependencyEdge[], k: number) {
  const paths = new Map<string, string[][]>();
  if (k === 0) return paths;
  const outgoing = new Map<string, ReportCardsV9DependencyEdge[]>();
  for (const edge of edges) {
    const group = outgoing.get(edge.from);
    if (group) group.push(edge); else outgoing.set(edge.from, [edge]);
  }
  type Candidate = { path: string[]; weight: number };
  const heap: Candidate[] = [];
  function push(candidate: Candidate) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].weight >= candidate.weight) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = candidate;
  }
  function pop(): Candidate {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].weight > heap[child].weight) child++;
        if (heap[child].weight <= last.weight) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  }
  const rootSet = new Set(roots);
  for (const root of rootSet) push({ path: [root], weight: 1 });
  while (heap.length) {
    const candidate = pop(), id = candidate.path[candidate.path.length - 1];
    const selected = paths.get(id) ?? [];
    if (selected.length >= k || selected.some(path => path.length === candidate.path.length && path.every((part, i) => part === candidate.path[i]))) continue;
    selected.push(candidate.path);
    paths.set(id, selected);
    for (const edge of outgoing.get(id) ?? []) {
      const weight = edgeShare(edge);
      if (weight === null || weight === 0 || rootSet.has(edge.to) || candidate.path.includes(edge.to)) continue;
      push({ path: [...candidate.path, edge.to], weight: candidate.weight * weight });
    }
  }
  return paths;
}

export function exposureFootprint(
  roots: readonly string[],
  edges: readonly ReportCardsV9DependencyEdge[],
  supplyOf: SupplyOf,
  opts: ExposureOptions & { topPaths?: number },
): { rows: ExposureRow[]; direct: FootprintTotals; indirect: FootprintTotals; reached: number; bandCounts: Record<ExposureBand, number> } {
  const shares = lookThroughShares(roots, edges), rootSet = new Set(roots);
  const incoming = byDependent(edges);
  const paths = topExposurePaths(roots, edges, Math.max(0, Math.floor(opts.topPaths ?? 3)));
  const materialShare = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.materialExposureShare;
  const bandCounts: Record<ExposureBand, number> = { material: 0, minor: 0, trace: 0, unknown: 0 };
  const rows: ExposureRow[] = [];
  const direct: FootprintTotals = { ...totals(), hasKnownUsd: false, overlapUpperBoundUsd: 0 };
  const indirect: FootprintTotals = { ...totals(), hasKnownUsd: false, overlapUpperBoundUsd: 0 };
  const upstreamShare = (id: string) => rootSet.has(id) ? 1 : shares.get(id)?.share ?? (shares.has(id) ? null : 0);
  const layerOf = (upstream: string) => rootSet.has(upstream) ? direct : indirect;
  const books = new Map<string, Map<string, BookMember[]>>();
  const unvaluedBookMembers = new Set<string>();
  const admittedUsd = new Map<string, number>();
  const downstreamUsd = new Map<string, number>();
  const unmatchedDownstream = new Set<string>();
  function recordUsd(upstream: string, usd: number, matchOverlap = true) {
    const layer = layerOf(upstream);
    layer.knownUsd += usd;
    layer.hasKnownUsd = true;
    if (layer === indirect && matchOverlap) downstreamUsd.set(upstream, (downstreamUsd.get(upstream) ?? 0) + usd);
  }
  for (const [id, value] of shares) {
    if (value.share === 0) continue;
    const group = incoming.get(id) ?? [];
    const band: ExposureBand = value.share === null ? "unknown" : value.share >= materialShare ? "material" : value.share >= 0.01 ? "minor" : "trace";
    bandCounts[band]++;
    const supply = supplyOf(id);
    rows.push({ id, minHop: value.minHop, share: value.share, band, exposureUsd: supply && value.share !== null ? supply.usd * value.share : null,
      // Materiality on any incoming edge determines score availability.
      scoreUnknown: group.some(edge => !v9DependencyEdgeScoreKnown(edge)),
      paths: paths.get(id) ?? [] });
    let serial: { from: string; share: number } | undefined, basketShare = 0;
    const basket: { from: string; share: number }[] = [];
    const reachedLayers = new Set<FootprintTotals>();
    const reachedIndirectParents = new Set<string>();
    const unknownLayers = new Set<FootprintTotals>();
    let reachedSerial = false;
    let serialTieIncludesIndirect = false;
    for (const edge of group) {
      const upstream = upstreamShare(edge.from);
      const weight = edgeShare(edge);
      if (upstream === 0 || weight === 0) continue;
      const layer = layerOf(edge.from);
      reachedLayers.add(layer);
      if (layer === indirect) reachedIndirectParents.add(edge.from);
      reachedSerial ||= edge.kind === "serial";
      if (upstream === null || weight === null) {
        unknownLayers.add(layer);
        continue;
      }
      const share = upstream * weight;
      if (edge.kind === "serial") {
        if (!serial || share > serial.share) {
          serial = { from: edge.from, share };
          serialTieIncludesIndirect = false;
        } else if (share === serial.share && edge.from !== serial.from) {
          const winnerIsIndirect = !rootSet.has(serial.from);
          serialTieIncludesIndirect ||= layer === indirect || winnerIsIndirect;
          if (layer === direct && winnerIsIndirect) serial = { from: edge.from, share };
        }
      } else {
        basket.push({ from: edge.from, share });
        basketShare += share;
      }
    }
    // Basket paths add across layers. A competing serial path can change which
    // contributions win, so an unresolved choice still quarantines both layers.
    const independentBaskets = value.share === null && !reachedSerial && unknownLayers.size > 0;
    const winningSerial = serial && serial.share >= basketShare ? serial : undefined;
    const contributions = value.share !== null ? (winningSerial ? [winningSerial] : basket)
      : independentBaskets ? basket.filter(({ from }) => !unknownLayers.has(layerOf(from))) : [];
    const affectedLayers = value.share === null ? reachedLayers : new Set(contributions.map(({ from }) => layerOf(from)));
    for (const layer of affectedLayers) {
      const unresolved = value.share === null && (!independentBaskets || unknownLayers.has(layer));
      layer.integrityFlag ||= unresolved || (value.share !== null && value.integrityFlag)
        || (independentBaskets && invalidBasket(group.filter(edge => layerOf(edge.from) === layer && upstreamShare(edge.from) !== 0)));
      if (unresolved) {
        layer.unknownShareEdgeCount++;
        if (layer === indirect) for (const from of reachedIndirectParents) unmatchedDownstream.add(from);
      }
      if (!supply) layer.excludedSupplyUnknownIds.push(id);
    }
    const book = group.some(edge => edge.kind === "serial") ? null : opts.sharedBooks.bookIdOf(id);
    for (const { from, share } of contributions) {
      const layer = layerOf(from);
      layer.integrityFlag ||= shares.get(from)?.integrityFlag ?? false;
      const usd = supply ? supply.usd * share : null;
      if (usd === null && layer === indirect) unmatchedDownstream.add(from);
      if (book) {
        const holdings = books.get(book) ?? new Map<string, BookMember[]>();
        const members = holdings.get(from) ?? [];
        members.push({ id, usd });
        holdings.set(from, members);
        books.set(book, holdings);
        if (usd === null) unvaluedBookMembers.add(id);
      } else if (usd !== null) {
        // A serial tie preserves the child's dollars while leaving its parent attribution unresolved.
        const ambiguous = winningSerial !== undefined && serialTieIncludesIndirect && usd > 0;
        if (ambiguous) indirect.overlapUnavailableReason ??= "serial-parent-attribution-ambiguous";
        recordUsd(from, usd, !ambiguous);
        admittedUsd.set(id, (admittedUsd.get(id) ?? 0) + usd);
      }
    }
  }
  const bookClaims = new Map<string, { usd: number; members: Set<string> }[]>();
  const measuredBooks = new Set<string>();
  for (const [book, holdings] of books) {
    const claims: { usd: number; members: Set<string> }[] = [];
    for (const [upstream, members] of holdings) {
      const knownMembers = members.flatMap(({ id, usd }) => usd === null ? [] : [{ id, usd }]);
      const modeledUsd = knownMembers.reduce((sum, member) => sum + member.usd, 0);
      const holdingUsd = opts.sharedBooks.measuredHoldingUsd(book, upstream);
      const share = upstreamShare(upstream);
      const measuredUsd = holdingUsd !== null && share !== null ? holdingUsd * share : null;
      if (measuredUsd !== null && measuredUsd > 0 && (modeledUsd !== 0 || knownMembers.length < members.length)) {
        measuredBooks.add(book);
      }
      if (measuredUsd !== null && modeledUsd !== 0) {
        recordUsd(upstream, measuredUsd);
        claims.push({ usd: measuredUsd, members: new Set(knownMembers.filter(member => member.usd > 0).map(({ id }) => id)) });
      } else if (knownMembers.length > 0) {
        recordUsd(upstream, modeledUsd);
        for (const { id, usd } of knownMembers) claims.push({ usd, members: new Set([id]) });
      }
    }
    bookClaims.set(book, claims);
  }
  for (const [upstream, downstream] of downstreamUsd) {
    indirect.overlapUsd += Math.min(downstream, admittedUsd.get(upstream) ?? 0);
  }
  for (const claims of bookClaims.values()) {
    // A holding can overlap any of its member claims. Their union limits
    // the bound when more than one holding is linked to the same member.
    const matchedMembers = new Set<string>();
    let holdingBound = 0;
    for (const { usd, members } of claims) {
      let downstream = 0;
      for (const id of members) {
        matchedMembers.add(id);
        downstream += downstreamUsd.get(id) ?? 0;
      }
      holdingBound += Math.min(usd, downstream);
    }
    let downstreamBound = 0;
    for (const id of matchedMembers) downstreamBound += downstreamUsd.get(id) ?? 0;
    indirect.overlapUsd += Math.min(holdingBound, downstreamBound);
  }
  for (const id of unvaluedBookMembers) {
    if ((downstreamUsd.get(id) ?? 0) > 0) unmatchedDownstream.add(id);
  }
  for (const id of unmatchedDownstream) {
    const book = opts.sharedBooks.bookIdOf(id);
    if (book && measuredBooks.has(book) && !incoming.get(id)?.some(edge => edge.kind === "serial")) {
      indirect.overlapUnavailableReason = "shared-book-claims-unmatched";
      break;
    }
  }
  for (const layer of [direct, indirect]) {
    layer.excludedSupplyUnknownIds.sort();
    layer.complete = layer.excludedSupplyUnknownIds.length === 0 && layer.unknownShareEdgeCount === 0 && !layer.integrityFlag;
  }
  // A complete empty layer cannot stand in for observations in an incomplete footprint.
  const hasKnownUsd = direct.hasKnownUsd || indirect.hasKnownUsd || (direct.complete && indirect.complete);
  direct.hasKnownUsd ||= hasKnownUsd && direct.complete;
  indirect.hasKnownUsd ||= hasKnownUsd && indirect.complete;
  indirect.overlapUpperBoundUsd = !hasKnownUsd || indirect.overlapUnavailableReason ? null : indirect.overlapUsd;
  rows.sort((a, b) => a.minHop - b.minHop || a.id.localeCompare(b.id));
  return { rows, direct, indirect, reached: rows.length, bandCounts };
}
