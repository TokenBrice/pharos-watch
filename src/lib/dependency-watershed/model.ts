import { buildDirectHubExposures, edgeShare, type ExposureOptions, type HubExposure, type SupplyOf } from "@shared/lib/dependency-exposure";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import { hubDirectKnown } from "./known";
import { createWidthScale, ribbonCenterline, ribbonPath, type RibbonStation } from "./geometry";
import { orderColumns, type OrderItem, type OrderSegment } from "./order";
import { findDependencyCycle, longestPathLayers, partitionBasins } from "./ranks";

export interface WatershedNodeInput {
  id: string;
  circulatingUsdAtEvaluation: number | null;
  supplyAsOfSec: number | null;
  sharedBookId: string | null;
}

export interface WatershedLayout {
  width: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  barWidth: number;
  /** Minimum row pitch for a drawn coin; keeps labels apart by construction. */
  minRow: number;
  /** Minimum row for a hub carrying a folded-dependents chip (label line + chip line). */
  deltaRow: number;
  /** Label line above a hub's outbound stack, so its label never sits on its own links. */
  labelBand: number;
  gap: number;
  groupGap: number;
  waypointGap: number;
  maxRibbonPx: number;
  floorPx: number;
  deltaStub: number;
  /** Dependents drawn individually under each expanded hub; the rest stay folded. */
  expandLimit: number;
}

export const DEFAULT_WATERSHED_LAYOUT: WatershedLayout = {
  width: 1200, padLeft: 4, padRight: 210, padTop: 6, padBottom: 6, barWidth: 10,
  minRow: 20, deltaRow: 26, labelBand: 12, gap: 6, groupGap: 14, waypointGap: 3,
  maxRibbonPx: 36, floorPx: 1, deltaStub: 16, expandLimit: 12,
};

export interface WatershedEdgeFact {
  key: string;
  edge: ReportCardsV9DependencyEdge;
  from: string;
  to: string;
  relationship: "collateral" | "wrapper";
  /** Mapped share of the dependent's supply: 1 for serial, published weight for basket, null when unknown. */
  share: number | null;
  /** Dependent's publication-bound supply × share; null when either is unknown. */
  usd: number | null;
}

export interface WatershedNode {
  id: string;
  kind: "hub" | "leaf";
  layer: number;
  column: number;
  x: number;
  y: number;
  height: number;
  /** Full-graph direct exposure from buildDirectHubExposures; null for leaves. */
  exposure: HubExposure | null;
  supplyUsd: number | null;
  showFigure: boolean;
  expanded: boolean;
}

export interface WatershedRibbon extends WatershedEdgeFact {
  width: number;
  unknown: boolean;
  floored: boolean;
  path: string;
  centerline: string;
  /** Layers this ribbon spans (1 for adjacent columns). */
  span: number;
  /** Centre of the ribbon where it meets the dependent. */
  end: { x: number; y: number };
}

export interface WatershedDelta {
  hubId: string;
  /** Folded dependents (a dependent with several upstreams is folded under each). */
  leafIds: string[];
  knownUsd: number;
  unknownCount: number;
  /** Folded dependents that also map to another upstream. */
  multiParentCount: number;
  /** True when the hub is expanded and this delta holds only the remainder. */
  remainder: boolean;
  shownCount: number;
  x: number;
  top: number;
  width: number;
  path: string;
}

export interface WatershedOtherBasin {
  id: string;
  nodeIds: string[];
  hubs: { id: string; exposure: HubExposure; dependents: WatershedEdgeFact[] }[];
  knownUsd: number;
}

export interface WatershedDisclosures {
  unknownEdgeCount: number;
  nullSupplyIds: string[];
  multiParentLeafIds: string[];
  /** Dependents carrying more than one full (serial) claim; gross semantics count each. */
  doubleSerialDependentIds: string[];
}

export type WatershedModel =
  | { ok: false; reason: "cycle"; members: string[] }
  | {
    ok: true;
    width: number;
    height: number;
    layout: WatershedLayout;
    columns: { layer: number; x: number }[];
    nodes: WatershedNode[];
    ribbons: WatershedRibbon[];
    deltas: WatershedDelta[];
    otherBasins: WatershedOtherBasin[];
    edges: WatershedEdgeFact[];
    hubExposures: Map<string, HubExposure>;
    /** Hubs whose direct USD is a statistic (see hubDirectKnown). */
    directKnown: Set<string>;
    layers: Map<string, number>;
    participantCount: number;
    mainBasinIds: string[];
    widthScale: { pxPerUsd: number; maxEdgeUsd: number; floorPx: number; floorUsd: number };
    disclosures: WatershedDisclosures;
  };

export interface WatershedInput {
  nodes: readonly WatershedNodeInput[];
  edges: readonly ReportCardsV9DependencyEdge[];
  expandedHubs?: readonly string[];
  /** Measured shared-book holdings; the publication does not yet publish them. */
  measuredHoldingUsd?: (bookId: string, upstreamId: string) => number | null;
  layout?: Partial<WatershedLayout>;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validShare(edge: ReportCardsV9DependencyEdge): boolean {
  return edge.kind === "serial" || edge.weight === null || (typeof edge.weight === "number" && Number.isFinite(edge.weight) && edge.weight >= 0 && edge.weight <= 1);
}

/** Publication-bound supply, the same basis Exposure mode uses. */
export function publicationSupplyOf(nodes: readonly WatershedNodeInput[]): SupplyOf {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return id => {
    const node = byId.get(id);
    const usd = node?.circulatingUsdAtEvaluation;
    return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? { usd, asOf: node?.supplyAsOfSec ?? null, basis: "publication-circulating" } : null;
  };
}

/**
 * Pure, deterministic layered view of the published dependency graph. Columns
 * are longest-path layers; leaves fold into per-hub aggregates; geometry is
 * linear in mapped USD so stacked ports add up. Printed hub totals come only
 * from buildDirectHubExposures.
 */
export function buildWatershedModel(input: WatershedInput): WatershedModel {
  const layout = { ...DEFAULT_WATERSHED_LAYOUT, ...input.layout };
  const published = new Set(input.nodes.map(node => node.id));
  const supplyOf = publicationSupplyOf(input.nodes);
  const bookOf = new Map(input.nodes.map(node => [node.id, node.sharedBookId]));

  // Keep only relationships with both endpoints published; malformed shares become unknown.
  const edges = input.edges
    .filter(edge => edge && published.has(edge.from) && published.has(edge.to))
    .map(edge => (edge.kind === "serial" || edge.kind === "basket") && validShare(edge) ? edge : { ...edge, kind: "basket" as const, weight: null })
    .sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to) || compareIds(a.kind, b.kind));
  const participants = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))].sort(compareIds);
  const cycle = findDependencyCycle(participants, edges);
  if (cycle) return { ok: false, reason: "cycle", members: cycle };

  const facts: WatershedEdgeFact[] = edges.map(edge => {
    const share = edgeShare(edge);
    const supply = supplyOf(edge.to);
    return {
      key: `${edge.from}>${edge.to}>${edge.kind}`, edge, from: edge.from, to: edge.to,
      relationship: edge.kind === "serial" ? "wrapper" : "collateral",
      share, usd: share === null || supply === null ? null : supply.usd * share,
    };
  });
  const options: ExposureOptions = {
    sharedBooks: { bookIdOf: id => bookOf.get(id) ?? null, measuredHoldingUsd: input.measuredHoldingUsd ?? (() => null) },
    familyOf: () => null,
    wrapperFormOf: () => "unknown",
  };
  const hubExposures = new Map(buildDirectHubExposures(edges, supplyOf, options).map(hub => [hub.hubId, hub]));
  const layers = longestPathLayers(participants, edges);
  const basins = partitionBasins(participants, edges);
  const outgoing = new Map<string, WatershedEdgeFact[]>(), incoming = new Map<string, WatershedEdgeFact[]>();
  for (const fact of facts) {
    (outgoing.get(fact.from) ?? outgoing.set(fact.from, []).get(fact.from)!).push(fact);
    (incoming.get(fact.to) ?? incoming.set(fact.to, []).get(fact.to)!).push(fact);
  }
  const isHub = (id: string) => outgoing.has(id);
  const knownUsd = (fact: WatershedEdgeFact) => fact.usd ?? 0;
  const byUsd = (a: WatershedEdgeFact, b: WatershedEdgeFact) =>
    (a.usd === null ? 1 : 0) - (b.usd === null ? 1 : 0) || knownUsd(b) - knownUsd(a) || (b.share ?? 0) - (a.share ?? 0) || compareIds(a.to, b.to) || compareIds(a.from, b.from);

  const scale = createWidthScale(Math.max(0, ...facts.map(knownUsd)), layout.maxRibbonPx, layout.floorPx);
  const disclosures: WatershedDisclosures = {
    unknownEdgeCount: facts.filter(fact => fact.usd === null).length,
    nullSupplyIds: participants.filter(id => supplyOf(id) === null),
    multiParentLeafIds: participants.filter(id => !isHub(id) && (incoming.get(id)?.length ?? 0) > 1),
    doubleSerialDependentIds: participants.filter(id => (incoming.get(id) ?? []).filter(fact => fact.edge.kind === "serial").length > 1),
  };

  const main = basins[0] ?? [];
  const otherBasins: WatershedOtherBasin[] = basins.slice(1).map(nodeIds => {
    const hubs = nodeIds.filter(isHub).map(id => ({ id, exposure: hubExposures.get(id)!, dependents: [...outgoing.get(id)!].sort(byUsd) }));
    return { id: nodeIds[0]!, nodeIds, hubs, knownUsd: hubs.reduce((sum, hub) => sum + hub.exposure.direct.knownUsd, 0) };
  }).sort((a, b) => b.knownUsd - a.knownUsd || compareIds(a.id, b.id));

  // Drawn set: every hub, plus the top dependents of expanded hubs.
  const expanded = new Set((input.expandedHubs ?? []).filter(id => main.includes(id) && isHub(id)));
  const drawn = new Set(main.filter(isHub));
  for (const hubId of [...expanded].sort(compareIds)) {
    for (const fact of outgoing.get(hubId)!.filter(fact => !isHub(fact.to)).sort(byUsd).slice(0, layout.expandLimit)) drawn.add(fact.to);
  }
  const drawnFacts = facts.filter(fact => drawn.has(fact.from) && drawn.has(fact.to));

  // Columns and virtual waypoints for links spanning more than one layer.
  const drawnIds = [...drawn].sort(compareIds);
  const maxLayer = Math.max(0, ...drawnIds.map(id => layers.get(id)!));
  const columnCount = maxLayer + 1;
  const spacing = (layout.width - layout.padLeft - layout.padRight - layout.barWidth) / Math.max(1, columnCount - 1);
  const columnX = (layer: number) => layout.padLeft + layer * spacing;
  const waypointId = (fact: WatershedEdgeFact, layer: number) => `~${fact.key}~${layer}`;
  const stationIds = new Map(drawnFacts.map(fact => {
    const ids = [fact.from];
    for (let layer = layers.get(fact.from)! + 1; layer < layers.get(fact.to)!; layer++) ids.push(waypointId(fact, layer));
    ids.push(fact.to);
    return [fact.key, ids];
  }));
  const primaryInbound = new Map<string, WatershedEdgeFact>();
  for (const id of drawnIds) {
    const inbound = (incoming.get(id) ?? []).filter(fact => drawn.has(fact.from)).sort((a, b) => byUsd(a, b));
    if (inbound[0]) primaryInbound.set(id, inbound[0]);
  }
  const items: OrderItem[][] = Array.from({ length: columnCount }, () => []);
  for (const id of drawnIds) {
    const primary = primaryInbound.get(id);
    const stations = primary ? stationIds.get(primary.key)! : null;
    items[layers.get(id)!]!.push({
      id, primaryParent: stations ? stations[stations.length - 2]! : null,
      value: isHub(id) ? hubExposures.get(id)!.direct.knownUsd : primary ? knownUsd(primary) : 0,
    });
  }
  const segments: OrderSegment[] = [];
  for (const fact of drawnFacts) {
    const ids = stationIds.get(fact.key)!;
    for (let i = 1; i < ids.length - 1; i++) items[layers.get(fact.from)! + i]!.push({ id: ids[i]!, primaryParent: ids[i - 1]!, value: knownUsd(fact) });
    for (let i = 1; i < ids.length; i++) segments.push({ from: ids[i - 1]!, to: ids[i]!, weight: Math.max(1, knownUsd(fact)) });
  }
  const order = orderColumns(items, segments);

  // Folded dependents per hub.
  const deltas = new Map<string, Omit<WatershedDelta, "x" | "top" | "width" | "path">>();
  for (const hubId of drawnIds.filter(isHub)) {
    const folded = outgoing.get(hubId)!.filter(fact => !drawn.has(fact.to)).sort(byUsd);
    if (!folded.length) continue;
    deltas.set(hubId, {
      hubId, leafIds: folded.map(fact => fact.to),
      knownUsd: folded.reduce((sum, fact) => sum + knownUsd(fact), 0),
      unknownCount: folded.filter(fact => fact.usd === null).length,
      multiParentCount: folded.filter(fact => (incoming.get(fact.to)?.length ?? 0) > 1).length,
      remainder: expanded.has(hubId),
      shownCount: outgoing.get(hubId)!.filter(fact => drawn.has(fact.to) && !isHub(fact.to)).length,
    });
  }
  const ribbonWidth = new Map(drawnFacts.map(fact => [fact.key, scale.width(fact.usd)]));
  const deltaWidth = (hubId: string) => {
    const delta = deltas.get(hubId);
    return delta ? scale.width(delta.knownUsd > 0 ? delta.knownUsd : null) : 0;
  };
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const nodeHeight = (id: string) => Math.max(
    layout.minRow,
    deltas.has(id) ? layout.deltaRow : 0,
    sum(drawnFacts.filter(fact => fact.to === id).map(fact => ribbonWidth.get(fact.key)!)),
    (isHub(id) ? layout.labelBand : 0) + sum(drawnFacts.filter(fact => fact.from === id).map(fact => ribbonWidth.get(fact.key)!)) + deltaWidth(id),
  );

  // Vertical packing: top-aligned columns, extra gap between tributary groups.
  const position = new Map<string, { x: number; y: number; height: number }>();
  const parentOf = new Map(items.flat().map(item => [item.id, item.primaryParent]));
  const waypointFact = new Map<string, WatershedEdgeFact>();
  for (const fact of drawnFacts) for (const id of stationIds.get(fact.key)!.slice(1, -1)) waypointFact.set(id, fact);
  let height = 0;
  order.forEach((column, layer) => {
    let y = layout.padTop, previous: string | null = null;
    for (const id of column) {
      const waypoint = waypointFact.get(id);
      if (previous !== null) {
        const bothWaypoints = waypoint && waypointFact.has(previous);
        y += bothWaypoints ? layout.waypointGap : parentOf.get(id) !== parentOf.get(previous) ? layout.groupGap : layout.gap;
      }
      const h = waypoint ? ribbonWidth.get(waypoint.key)! : nodeHeight(id);
      position.set(id, { x: columnX(layer), y, height: h });
      y += h;
      previous = id;
    }
    height = Math.max(height, y + layout.padBottom);
  });

  // Ports: outbound stacks in target order with the delta last; inbound in source order.
  const outTop = new Map<string, number>(), inTop = new Map<string, number>();
  for (const id of drawnIds) {
    const node = position.get(id)!;
    let cursor = node.y + (isHub(id) ? layout.labelBand : 0);
    const nextY = (fact: WatershedEdgeFact) => position.get(stationIds.get(fact.key)![1]!)!.y;
    for (const fact of drawnFacts.filter(fact => fact.from === id).sort((a, b) => nextY(a) - nextY(b) || compareIds(a.key, b.key))) {
      outTop.set(fact.key, cursor);
      cursor += ribbonWidth.get(fact.key)!;
    }
    outTop.set(`delta:${id}`, cursor);
    cursor = node.y;
    const prevY = (fact: WatershedEdgeFact) => { const ids = stationIds.get(fact.key)!; return position.get(ids[ids.length - 2]!)!.y; };
    for (const fact of drawnFacts.filter(fact => fact.to === id).sort((a, b) => prevY(a) - prevY(b) || compareIds(a.key, b.key))) {
      inTop.set(fact.key, cursor);
      cursor += ribbonWidth.get(fact.key)!;
    }
  }

  const ribbons: WatershedRibbon[] = drawnFacts.map(fact => {
    const ids = stationIds.get(fact.key)!;
    const width = ribbonWidth.get(fact.key)!;
    const stations: RibbonStation[] = ids.map((id, index) => {
      const point = position.get(id)!;
      if (index === 0) return { xIn: point.x, xOut: point.x + layout.barWidth, top: outTop.get(fact.key)! };
      if (index === ids.length - 1) return { xIn: point.x, xOut: point.x, top: inTop.get(fact.key)! };
      return { xIn: point.x, xOut: point.x + layout.barWidth, top: point.y };
    });
    return { ...fact, width, unknown: fact.usd === null, floored: fact.usd === null || fact.usd * scale.pxPerUsd < layout.floorPx,
      path: ribbonPath(stations, width), centerline: ribbonCenterline(stations, width), span: ids.length - 1,
      end: { x: stations[stations.length - 1]!.xIn, y: stations[stations.length - 1]!.top + width / 2 } };
  }).sort((a, b) => b.width - a.width || compareIds(a.key, b.key));

  const directKnown = new Set([...hubExposures.values()].filter(hub => hubDirectKnown(hub, edges)).map(hub => hub.hubId));
  const totalDirect = sum([...hubExposures.values()].map(hub => hub.direct.knownUsd));
  const nodes: WatershedNode[] = drawnIds.map(id => {
    const point = position.get(id)!;
    const exposure = hubExposures.get(id) ?? null;
    return { id, kind: isHub(id) ? "hub" as const : "leaf" as const, layer: layers.get(id)!, column: layers.get(id)!, x: point.x, y: point.y, height: point.height,
      exposure, supplyUsd: supplyOf(id)?.usd ?? null,
      showFigure: exposure !== null && directKnown.has(id) && exposure.direct.knownUsd > 0 && totalDirect > 0 && exposure.direct.knownUsd / totalDirect >= 0.01,
      expanded: expanded.has(id) };
  }).sort((a, b) => a.column - b.column || a.y - b.y);

  const placedDeltas: WatershedDelta[] = [...deltas.values()].map(delta => {
    const hub = position.get(delta.hubId)!;
    const width = deltaWidth(delta.hubId);
    const x = hub.x + layout.barWidth;
    const top = outTop.get(`delta:${delta.hubId}`)!;
    return { ...delta, x, top, width, path: ribbonPath([{ xIn: x, xOut: x, top }, { xIn: x + layout.deltaStub, xOut: x + layout.deltaStub, top }], width) };
  }).sort((a, b) => compareIds(a.hubId, b.hubId));

  return {
    ok: true, width: layout.width, height, layout,
    columns: Array.from({ length: columnCount }, (_, layer) => ({ layer, x: columnX(layer) })),
    nodes, ribbons, deltas: placedDeltas, otherBasins, edges: facts, hubExposures, directKnown, layers,
    participantCount: participants.length, mainBasinIds: main,
    widthScale: { pxPerUsd: scale.pxPerUsd, maxEdgeUsd: scale.maxEdgeUsd, floorPx: scale.floorPx, floorUsd: scale.floorUsd },
    disclosures,
  };
}
