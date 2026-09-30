import type { ReportCardsV9DependencyEdge } from "../types/report-cards-v9";
import { V9_CANDIDATE_POLICY_V1 } from "./safety-score-v9/policy";

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

  // Tarjan identifies cycle members, not the acyclic descendants blocked by them.
  const indices = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>(), cyclic = new Set<string>();
  let nextIndex = 0;
  function visit(id: string) {
    indices.set(id, nextIndex);
    low.set(id, nextIndex++);
    stack.push(id);
    onStack.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (!indices.has(edge.to)) {
        visit(edge.to);
        low.set(id, Math.min(low.get(id)!, low.get(edge.to)!));
      } else if (onStack.has(edge.to)) low.set(id, Math.min(low.get(id)!, indices.get(edge.to)!));
    }
    if (low.get(id) !== indices.get(id)) return;
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      members.push(member);
    } while (member !== id);
    if (members.length > 1 || (outgoing.get(id) ?? []).some(edge => edge.to === id)) {
      for (const memberId of members) cyclic.add(memberId);
    }
  }
  for (const id of queue) if (!indices.has(id)) visit(id);

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
    let serialTerm = 0, basketTerm = 0;
    let unknown = group.some(edge => edgeShare(edge) === null);
    let integrityFlag = invalidBasket(group) || unknown;
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
): { rows: ExposureRow[]; direct: ExposureTotals; indirect: ExposureTotals; reached: number; bandCounts: Record<ExposureBand, number> } {
  const shares = lookThroughShares(roots, edges), rootSet = new Set(roots);
  const incoming = byDependent(edges);
  const paths = topExposurePaths(roots, edges, Math.max(0, Math.floor(opts.topPaths ?? 3)));
  const materialShare = V9_CANDIDATE_POLICY_V1.policy.semantic.backing.structural.materialExposureShare;
  const bandCounts: Record<ExposureBand, number> = { material: 0, minor: 0, trace: 0, unknown: 0 };
  const rows: ExposureRow[] = [];
  const effective: ReportCardsV9DependencyEdge[] = [];
  const upstreamShare = (id: string) => rootSet.has(id) ? 1 : shares.get(id)?.share ?? (shares.has(id) ? null : 0);
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
    let serial: ReportCardsV9DependencyEdge | undefined, serialShare = 0, basketShare = 0;
    const basket: ReportCardsV9DependencyEdge[] = [];
    for (const edge of group) {
      const upstream = upstreamShare(edge.from);
      if (upstream === 0) continue;
      const weight = edgeShare(edge);
      const contribution = upstream === null || weight === null ? null : upstream * weight;
      if (edge.kind === "serial" && contribution !== null) {
        if (!serial || contribution > serialShare) { serial = edge; serialShare = contribution; }
      } else {
        basket.push({ ...edge, kind: "basket", weight: contribution });
        basketShare += contribution ?? 0;
      }
    }
    if (value.share === null) effective.push({ from: id, to: id, kind: "basket", weight: null, materiality: "basket-weighted", upstreamScore: null });
    else if (serial && serialShare >= basketShare) {
      effective.push({ ...serial, kind: "basket", weight: serialShare }, ...basket.filter(edge => edge.weight === null));
    }
    else effective.push(...basket);
  }
  const bookIdOf = (id: string) => (incoming.get(id) ?? []).some(edge => edge.kind === "serial") ? null : opts.sharedBooks.bookIdOf(id);
  const bookAmounts = new Map<string, Map<string, { direct: number; indirect: number }>>();
  for (const edge of effective) {
    const book = bookIdOf(edge.to), supply = supplyOf(edge.to);
    if (!book || !supply || edge.weight === null) continue;
    let holdings = bookAmounts.get(book);
    if (!holdings) { holdings = new Map(); bookAmounts.set(book, holdings); }
    const amounts = holdings.get(edge.from) ?? { direct: 0, indirect: 0 };
    if (shares.get(edge.to)!.minHop === 1) amounts.direct += supply.usd * edge.weight;
    else amounts.indirect += supply.usd * edge.weight;
    holdings.set(edge.from, amounts);
  }
  function totalFor(direct: boolean): ExposureTotals {
    const selected = effective.filter(edge => (shares.get(edge.to)!.minHop === 1) === direct);
    const scaledOpts: ExposureOptions = { ...opts, sharedBooks: {
      bookIdOf,
      measuredHoldingUsd: (book, upstream) => {
        const holding = opts.sharedBooks.measuredHoldingUsd(book, upstream), share = upstreamShare(upstream);
        const amounts = bookAmounts.get(book)?.get(upstream);
        if (holding === null || share === null || !amounts) return null;
        const sum = amounts.direct + amounts.indirect;
        return sum === 0 ? 0 : holding * share * (direct ? amounts.direct : amounts.indirect) / sum;
      },
    } };
    const mapped = mappedDependentSupply(selected, supplyOf, scaledOpts);
    const total: ExposureTotals = {
      knownUsd: mapped.knownUsd, excludedSupplyUnknownIds: mapped.excludedSupplyUnknownIds,
      unknownShareEdgeCount: mapped.unknownShareEdgeCount, complete: mapped.complete,
      overlapUsd: 0, integrityFlag: mapped.integrityFlag,
    };
    const overlapBooks = new Map<string, Map<string, number>>();
    for (const edge of selected) {
      if (!shares.has(edge.from) || edge.weight === null) continue;
      const supply = supplyOf(edge.to);
      if (!supply) continue;
      const book = bookIdOf(edge.to), amount = supply.usd * edge.weight;
      if (!book) total.overlapUsd += amount;
      else {
        let holdings = overlapBooks.get(book);
        if (!holdings) { holdings = new Map(); overlapBooks.set(book, holdings); }
        holdings.set(edge.from, (holdings.get(edge.from) ?? 0) + amount);
      }
    }
    for (const [book, holdings] of overlapBooks) {
      for (const [upstream, fallback] of holdings) total.overlapUsd += scaledOpts.sharedBooks.measuredHoldingUsd(book, upstream) ?? fallback;
    }
    total.integrityFlag ||= rows.some(row => (row.minHop === 1) === direct && shares.get(row.id)!.integrityFlag);
    total.complete &&= !total.integrityFlag;
    return total;
  }
  rows.sort((a, b) => a.minHop - b.minHop || a.id.localeCompare(b.id));
  return { rows, direct: totalFor(true), indirect: totalFor(false), reached: rows.length, bandCounts };
}
