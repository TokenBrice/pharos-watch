import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { percentileLinear } from "@shared/lib/stats";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { deterministicHash } from "@/lib/layout-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The relationship an edge draws. V9 carries a four-value `materiality` that
 * also encodes whether the upstream score resolved, but that is a data-quality
 * fact the detail modules report — the map's job is showing the relationships,
 * so it collapses materiality onto the two structural kinds.
 */
export type ContagionEdgeRelationship = "collateral" | "wrapper";

/** Minimal per-asset projection the graph needs; callers resolve names from the client registry. */
export interface ContagionGraphCard {
  id: string;
  symbol: string;
  grade: V9Grade;
  isDefunct?: boolean;
}

export interface GraphNode extends SimulationNodeDatum {
  id: string;
  symbol: string;
  grade: V9Grade;
  mcap: number;
  r: number;
}

export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  weight: number;
  type: ContagionEdgeRelationship;
}

export interface RawGraphLink {
  source: string;
  target: string;
  weight: number;
  type: ContagionEdgeRelationship;
}

export type HubTier = 0 | 1 | 2;

export interface LayoutTarget {
  x: number;
  y: number;
}

export interface SupernodeState {
  tierById: Map<string, HubTier>;
  scoreById: Map<string, number>;
  layoutTargetById: Map<string, LayoutTarget>;
  anchorStrengthById: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WIDTH = 800;
export const HEIGHT = 600;
export const PAD = 44;
export const MAX_NODES = 50;
export const ALL_NODE_LIMIT = "all";
export const NODE_LIMIT_OPTIONS = [50, 100, 200, ALL_NODE_LIMIT] as const;
export type NodeLimitOption = (typeof NODE_LIMIT_OPTIONS)[number];
export type GraphNodeLimit = number | typeof ALL_NODE_LIMIT;
// The post-simulation collision-correction pass is O(n²) per outer pass. Selecting
// ALL bypasses the 50/100/200 node caps and can feed the full live coin set into it,
// blocking the main thread. Bound the manual pass to the top-ranked nodes (the largest
// 200 NODE_LIMIT_OPTIONS value) so the 50/100/200 selections are unaffected and only
// the ALL view is capped; the long tail keeps its d3-force forceCollide positions.
export const MAX_COLLISION_PASS_NODES = 200;
// Opening view for the full map. 200 is the largest fixed option and stays inside
// MAX_COLLISION_PASS_NODES, so the default costs no more layout work than the
// deepest bounded selection a user can pick.
export const DEFAULT_NODE_LIMIT: NodeLimitOption = 200;
export const MIN_RADIUS = 10;
const MAX_RADIUS = 34;
export const RING_WIDTH = 3;
export const HUB_LABEL_FONT_SIZE = 11;
const CORE_PAIR_X_JITTER = 12;
const CORE_PAIR_Y_OFFSET = 118;
const CORE_RING_RADIUS_X = 102;
const CORE_RING_RADIUS_Y = 74;
const TIER2_RING_RADIUS_X = 214;
const TIER2_RING_RADIUS_Y = 154;
const CORE_LANE_HALF_WIDTH = 56;
const CORE_LANE_MARGIN = 10;

export const SUPERNODE_CONFIG = {
  weightInWeight: 0.5,
  weightInDegree: 0.25,
  weightTotalDegree: 0.15,
  weightMcap: 0.1,

  corePercentile: 0.9,
  secondaryPercentile: 0.75,

  coreHoldPercentile: 0.8,
  secondaryHoldPercentile: 0.65,

  minCoreInDegree: 2,
  minSecondaryInDegree: 1,
  minSecondaryInWeight: 0.1,

  minTier1: 2,
  maxTier1: 3,
  minTier2: 3,
  maxTier2: 5,

  sparseEdgeCutoff: 12,
  sparseTier1Count: 2,
} as const;

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

export function minMaxNormalize(ids: string[], valueById: Map<string, number>): Map<string, number> {
  if (!ids.length) return new Map<string, number>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    const v = valueById.get(id) ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return new Map(ids.map((id) => [id, 0]));
  }
  const span = max - min;
  return new Map(ids.map((id) => [id, ((valueById.get(id) ?? 0) - min) / span]));
}

export function deterministicJitter(id: string, salt: number, range: number): number {
  const hash = deterministicHash(id, salt);
  return ((hash % 1000) / 999 - 0.5) * 2 * range;
}

export function clampGraphPosition(x: number, y: number, r: number): LayoutTarget {
  return {
    x: Math.max(PAD + r, Math.min(WIDTH - PAD - r, x)),
    y: Math.max(PAD + r, Math.min(HEIGHT - PAD - r, y)),
  };
}

function placeOnEllipse(
  ids: string[],
  radiusX: number,
  radiusY: number,
  startAngle: number,
  targetById: Map<string, LayoutTarget>,
): void {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i++) {
    const angle = startAngle + (i / ids.length) * Math.PI * 2;
    targetById.set(ids[i], {
      x: WIDTH / 2 + Math.cos(angle) * radiusX,
      y: HEIGHT / 2 + Math.sin(angle) * radiusY,
    });
  }
}

function pushTargetsOutOfLane(
  targetById: Map<string, LayoutTarget>,
  coreA: LayoutTarget,
  coreB: LayoutTarget,
  excludedIds: Set<string>,
): void {
  const vx = coreB.x - coreA.x;
  const vy = coreB.y - coreA.y;
  const len = Math.hypot(vx, vy);
  if (len < 1) return;
  const len2 = len * len;
  const nx = -vy / len;
  const ny = vx / len;

  for (const [id, p] of targetById) {
    if (excludedIds.has(id)) continue;
    const apx = p.x - coreA.x;
    const apy = p.y - coreA.y;
    const t = (apx * vx + apy * vy) / len2;
    if (t <= 0.08 || t >= 0.92) continue;

    const cx = coreA.x + vx * t;
    const cy = coreA.y + vy * t;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist >= CORE_LANE_HALF_WIDTH) continue;

    const sideSign = (dx * nx + dy * ny) >= 0 ? 1 : -1;
    const push = (CORE_LANE_HALF_WIDTH - dist) + CORE_LANE_MARGIN;
    p.x += nx * push * sideSign;
    p.y += ny * push * sideSign;
  }
}

// ---------------------------------------------------------------------------
// buildGraphData
// ---------------------------------------------------------------------------

/**
 * Dimensionless exposure magnitude for one V9 edge, matching
 * `buildDependencyHubsModel`: a serial dependency is full pass-through, a
 * basket dependency carries its published weight, and a bounded-unknown
 * basket weight contributes nothing to the modeled magnitude.
 */
export function contagionEdgeWeight(edge: ReportCardsV9DependencyEdge): number {
  return edge.kind === "serial" ? 1 : edge.weight ?? 0;
}

/**
 * Collapses V9 `materiality` onto the drawn relationship. The disposition also
 * records whether the upstream score resolved (`serial-blocked`,
 * `basket-bounded-unknown`), which the map deliberately discards — see
 * `ContagionEdgeRelationship`.
 */
function contagionEdgeRelationship(edge: ReportCardsV9DependencyEdge): ContagionEdgeRelationship {
  return edge.kind === "serial" ? "wrapper" : "collateral";
}

export function buildGraphData(
  cards: readonly ContagionGraphCard[],
  mcapMap: Map<string, number>,
  dependencyEdges: readonly ReportCardsV9DependencyEdge[],
  maxNodes: GraphNodeLimit = MAX_NODES,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  const liveIds = [...cardMap.keys()].filter((id) => !cardMap.get(id)!.isDefunct);
  const liveIdSet = new Set(liveIds);
  const liveEdges = dependencyEdges.filter((edge) => liveIdSet.has(edge.from) && liveIdSet.has(edge.to));

  const inboundCounts = new Map<string, number>();
  const outboundCounts = new Map<string, number>();
  const liveLinks: RawGraphLink[] = [];

  for (const edge of liveEdges) {
    inboundCounts.set(edge.from, (inboundCounts.get(edge.from) ?? 0) + 1);
    outboundCounts.set(edge.to, (outboundCounts.get(edge.to) ?? 0) + 1);
    liveLinks.push({
      source: edge.to,
      target: edge.from,
      weight: contagionEdgeWeight(edge),
      type: contagionEdgeRelationship(edge),
    });
  }

  const rankedIds = liveIds
    .filter((id) => (inboundCounts.get(id) ?? 0) > 0 || (outboundCounts.get(id) ?? 0) > 0)
    .sort((a, b) => (mcapMap.get(b) ?? 0) - (mcapMap.get(a) ?? 0));

  const maxSelectedNodes = maxNodes === ALL_NODE_LIMIT ? rankedIds.length : maxNodes;
  let selectedIds = rankedIds.slice(0, maxSelectedNodes);
  let nextCandidateIdx = selectedIds.length;
  let selectedLinks: RawGraphLink[] = [];

  while (selectedIds.length > 0) {
    const idSet = new Set(selectedIds);
    selectedLinks = liveLinks.filter((link) => idSet.has(link.source) && idSet.has(link.target));

    const connectedIds = new Set<string>();
    for (const link of selectedLinks) {
      connectedIds.add(link.source);
      connectedIds.add(link.target);
    }

    const prunedIds = selectedIds.filter((id) => connectedIds.has(id));
    const removedCount = selectedIds.length - prunedIds.length;
    selectedIds = prunedIds;

    while (selectedIds.length < maxSelectedNodes && nextCandidateIdx < rankedIds.length) {
      selectedIds.push(rankedIds[nextCandidateIdx]);
      nextCandidateIdx++;
    }

    if (removedCount === 0) break;
  }

  const mcaps = selectedIds.map((id) => mcapMap.get(id) ?? 0);
  const maxMcap = mcaps.reduce((m, v) => Math.max(m, v), 1);

  const graphNodes: GraphNode[] = selectedIds.map((id) => {
    const card = cardMap.get(id)!;
    const mcap = mcapMap.get(id) ?? 0;
    const r = MIN_RADIUS + Math.sqrt(mcap / maxMcap) * (MAX_RADIUS - MIN_RADIUS);
    return { id, symbol: card.symbol, grade: card.grade, mcap, r };
  });

  const graphLinks: GraphLink[] = selectedLinks;

  return { nodes: graphNodes, links: graphLinks };
}

// ---------------------------------------------------------------------------
// buildSupernodeState
// ---------------------------------------------------------------------------

export function buildSupernodeState(
  nodes: GraphNode[],
  links: GraphLink[],
  prevTierById?: Map<string, HubTier>,
): SupernodeState {
  const ids = nodes.map((n) => n.id);
  const inWeightById = new Map<string, number>();
  const inDegreeById = new Map<string, number>();
  const outDegreeById = new Map<string, number>();
  const mcapLogById = new Map<string, number>();

  for (const node of nodes) {
    inWeightById.set(node.id, 0);
    inDegreeById.set(node.id, 0);
    outDegreeById.set(node.id, 0);
    mcapLogById.set(node.id, Math.log10(Math.max(0, node.mcap) + 1));
  }

  for (const link of links) {
    const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
    const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
    if (!inWeightById.has(tgtId) || !outDegreeById.has(srcId)) continue;
    inWeightById.set(tgtId, (inWeightById.get(tgtId) ?? 0) + link.weight);
    inDegreeById.set(tgtId, (inDegreeById.get(tgtId) ?? 0) + 1);
    outDegreeById.set(srcId, (outDegreeById.get(srcId) ?? 0) + 1);
  }

  const totalDegreeById = new Map<string, number>();
  for (const id of ids) {
    totalDegreeById.set(id, (inDegreeById.get(id) ?? 0) + (outDegreeById.get(id) ?? 0));
  }

  const inWeightNorm = minMaxNormalize(ids, inWeightById);
  const inDegreeNorm = minMaxNormalize(ids, inDegreeById);
  const totalDegreeNorm = minMaxNormalize(ids, totalDegreeById);
  const mcapNorm = minMaxNormalize(ids, mcapLogById);

  const scoreById = new Map<string, number>();
  for (const id of ids) {
    const score =
      (inWeightNorm.get(id) ?? 0) * SUPERNODE_CONFIG.weightInWeight +
      (inDegreeNorm.get(id) ?? 0) * SUPERNODE_CONFIG.weightInDegree +
      (totalDegreeNorm.get(id) ?? 0) * SUPERNODE_CONFIG.weightTotalDegree +
      (mcapNorm.get(id) ?? 0) * SUPERNODE_CONFIG.weightMcap;
    scoreById.set(id, score);
  }

  const sortedByScore = [...ids].sort((a, b) => (scoreById.get(b) ?? 0) - (scoreById.get(a) ?? 0));
  const scores = sortedByScore.map((id) => scoreById.get(id) ?? 0);

  const pCoreEnter = percentileLinear(scores, SUPERNODE_CONFIG.corePercentile * 100) ?? 0;
  const pCoreHold = percentileLinear(scores, SUPERNODE_CONFIG.coreHoldPercentile * 100) ?? 0;
  const pSecondaryEnter = percentileLinear(scores, SUPERNODE_CONFIG.secondaryPercentile * 100) ?? 0;
  const pSecondaryHold = percentileLinear(scores, SUPERNODE_CONFIG.secondaryHoldPercentile * 100) ?? 0;

  const tierById = new Map<string, HubTier>(ids.map((id) => [id, 0]));

  const isSparse = links.length < SUPERNODE_CONFIG.sparseEdgeCutoff;
  let tier1Ids: string[] = [];
  let tier2Ids: string[] = [];

  if (isSparse) {
    tier1Ids = sortedByScore.slice(0, Math.min(SUPERNODE_CONFIG.sparseTier1Count, sortedByScore.length));
  } else {
    const entryTierById = new Map<string, HubTier>();

    for (const id of sortedByScore) {
      const score = scoreById.get(id) ?? 0;
      const inDegree = inDegreeById.get(id) ?? 0;
      const inWeight = inWeightById.get(id) ?? 0;
      const prevTier = prevTierById?.get(id) ?? 0;

      const coreEnter = score >= pCoreEnter && inDegree >= SUPERNODE_CONFIG.minCoreInDegree;
      const coreStay = score >= pCoreHold && inDegree >= SUPERNODE_CONFIG.minCoreInDegree;
      const secondaryEnter = score >= pSecondaryEnter
        && (inDegree >= SUPERNODE_CONFIG.minSecondaryInDegree || inWeight >= SUPERNODE_CONFIG.minSecondaryInWeight);
      const secondaryStay = score >= pSecondaryHold
        && (inDegree >= SUPERNODE_CONFIG.minSecondaryInDegree || inWeight >= SUPERNODE_CONFIG.minSecondaryInWeight);

      let tier: HubTier = 0;
      if ((prevTier === 2 && coreStay) || coreEnter) {
        tier = 2;
      } else if ((prevTier >= 1 && secondaryStay) || secondaryEnter) {
        tier = 1;
      }
      entryTierById.set(id, tier);
    }

    tier1Ids = sortedByScore.filter((id) => entryTierById.get(id) === 2).slice(0, SUPERNODE_CONFIG.maxTier1);

    if (tier1Ids.length < SUPERNODE_CONFIG.minTier1) {
      for (const id of sortedByScore) {
        if (tier1Ids.includes(id)) continue;
        tier1Ids.push(id);
        if (tier1Ids.length >= SUPERNODE_CONFIG.minTier1) break;
      }
    }

    tier2Ids = sortedByScore
      .filter((id) => !tier1Ids.includes(id) && (entryTierById.get(id) ?? 0) >= 1)
      .slice(0, SUPERNODE_CONFIG.maxTier2);

    if (tier2Ids.length < SUPERNODE_CONFIG.minTier2) {
      for (const id of sortedByScore) {
        if (tier1Ids.includes(id) || tier2Ids.includes(id)) continue;
        tier2Ids.push(id);
        if (tier2Ids.length >= SUPERNODE_CONFIG.minTier2) break;
      }
    }
  }

  for (const id of tier1Ids) tierById.set(id, 2);
  for (const id of tier2Ids) tierById.set(id, 1);

  const layoutTargetById = new Map<string, LayoutTarget>();

  if (tier1Ids.length === 1) {
    layoutTargetById.set(tier1Ids[0], { x: WIDTH / 2, y: HEIGHT / 2 });
  } else if (tier1Ids.length === 2) {
    layoutTargetById.set(tier1Ids[0], {
      x: WIDTH / 2 - CORE_PAIR_X_JITTER,
      y: HEIGHT / 2 - CORE_PAIR_Y_OFFSET,
    });
    layoutTargetById.set(tier1Ids[1], {
      x: WIDTH / 2 + CORE_PAIR_X_JITTER,
      y: HEIGHT / 2 + CORE_PAIR_Y_OFFSET,
    });
  } else {
    placeOnEllipse(tier1Ids, CORE_RING_RADIUS_X, CORE_RING_RADIUS_Y, -Math.PI / 2, layoutTargetById);
  }

  placeOnEllipse(tier2Ids, TIER2_RING_RADIUS_X, TIER2_RING_RADIUS_Y, -Math.PI / 2, layoutTargetById);

  const tieredIds = new Set([...tier1Ids, ...tier2Ids]);
  const outerIds = sortedByScore.filter((id) => !tieredIds.has(id));
  if (outerIds.length > 30) {
    const cut = Math.ceil(outerIds.length * 0.58);
    placeOnEllipse(outerIds.slice(0, cut), 305, 224, -Math.PI / 2, layoutTargetById);
    placeOnEllipse(outerIds.slice(cut), 252, 184, -Math.PI / 2 + Math.PI / Math.max(8, outerIds.length), layoutTargetById);
  } else {
    placeOnEllipse(outerIds, 284, 208, -Math.PI / 2, layoutTargetById);
  }

  if (tier1Ids.length === 2) {
    const coreA = layoutTargetById.get(tier1Ids[0]);
    const coreB = layoutTargetById.get(tier1Ids[1]);
    if (coreA && coreB) {
      pushTargetsOutOfLane(layoutTargetById, coreA, coreB, new Set(tier1Ids));
    }
  }

  const anchorStrengthById = new Map<string, number>();
  for (const id of ids) {
    const tier = tierById.get(id) ?? 0;
    anchorStrengthById.set(id, tier === 2 ? 0.24 : tier === 1 ? 0.105 : 0.04);
  }

  return { tierById, scoreById, layoutTargetById, anchorStrengthById };
}

// ---------------------------------------------------------------------------
// runSimulation
// ---------------------------------------------------------------------------

export function runSimulation(
  nodes: GraphNode[],
  links: GraphLink[],
  supernodeState: SupernodeState,
): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map();

  const simNodes = nodes.map((n) => ({ ...n }));
  const simLinks = links.map((l) => ({ ...l }));
  const { layoutTargetById, anchorStrengthById } = supernodeState;

  for (const n of simNodes) {
    const target = layoutTargetById.get(n.id);
    if (!target) continue;
    n.x = target.x + deterministicJitter(n.id, 17, 8);
    n.y = target.y + deterministicJitter(n.id, 53, 8);
  }

  const MIN_GAP = 8;

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<GraphNode, GraphLink>(simLinks)
        .id((d) => d.id)
        .distance(100)
        .strength((l) => (l as GraphLink).weight * 0.4),
    )
    .force(
      "charge",
      forceManyBody().strength((d) => -200 - (d as GraphNode).r * 4),
    )
    .force(
      "x",
      forceX<GraphNode>((d) => layoutTargetById.get(d.id)?.x ?? WIDTH / 2)
        .strength((d) => anchorStrengthById.get(d.id) ?? 0.05),
    )
    .force(
      "y",
      forceY<GraphNode>((d) => layoutTargetById.get(d.id)?.y ?? HEIGHT / 2)
        .strength((d) => anchorStrengthById.get(d.id) ?? 0.05),
    )
    .force(
      "collide",
      forceCollide<GraphNode>()
        .radius((d) => d.r + MIN_GAP)
        .iterations(4),
    )
    .stop();

  for (let i = 0; i < 300; i++) sim.tick();

  const MAX_PASSES = 100;
  const xMin = PAD;
  const xMax = WIDTH - PAD;
  const yMin = PAD;
  const yMax = HEIGHT - PAD;

  // Bound the O(n²) all-pairs correction to the top-ranked nodes; simNodes is rank
  // ordered, so the 50/100/200 selections (all <= MAX_COLLISION_PASS_NODES) are
  // unchanged and only the ALL view is capped. See MAX_COLLISION_PASS_NODES.
  const collisionNodeCount = Math.min(simNodes.length, MAX_COLLISION_PASS_NODES);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let violations = 0;

    for (let i = 0; i < collisionNodeCount; i++) {
      for (let j = i + 1; j < collisionNodeCount; j++) {
        const a = simNodes[i];
        const b = simNodes[j];
        const dx = (b.x ?? 0) - (a.x ?? 0);
        const dy = (b.y ?? 0) - (a.y ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.r + b.r + MIN_GAP;

        if (dist < minDist) {
          violations++;
          if (dist > 0.1) {
            const push = (minDist - dist) / 2 + 0.5;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x = (a.x ?? 0) - nx * push;
            a.y = (a.y ?? 0) - ny * push;
            b.x = (b.x ?? 0) + nx * push;
            b.y = (b.y ?? 0) + ny * push;
          } else {
            const angle = ((i * 7 + j * 13) % 100) / 100 * Math.PI * 2;
            const push = minDist / 2;
            a.x = (a.x ?? 0) - Math.cos(angle) * push;
            a.y = (a.y ?? 0) - Math.sin(angle) * push;
            b.x = (b.x ?? 0) + Math.cos(angle) * push;
            b.y = (b.y ?? 0) + Math.sin(angle) * push;
          }
        }
      }
    }

    for (const n of simNodes) {
      const x = n.x ?? WIDTH / 2;
      const y = n.y ?? HEIGHT / 2;
      if (x - n.r < xMin) { violations++; n.x = xMin + n.r + 0.5; }
      else if (x + n.r > xMax) { violations++; n.x = xMax - n.r - 0.5; }
      if (y - n.r < yMin) { violations++; n.y = yMin + n.r + 0.5; }
      else if (y + n.r > yMax) { violations++; n.y = yMax - n.r - 0.5; }
    }

    if (violations === 0) break;
  }

  const posMap = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) {
    posMap.set(n.id, { x: n.x ?? WIDTH / 2, y: n.y ?? HEIGHT / 2 });
  }

  return posMap;
}
