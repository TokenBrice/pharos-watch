"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { deriveDependencies } from "@/lib/reserve-templates";
import { GRADE_RADAR_COLORS, gradeRange } from "@/lib/report-cards";
import type { DependencyType, ReportCard, ReportCardGrade } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GraphNode extends SimulationNodeDatum {
  id: string;
  symbol: string;
  grade: string;
  mcap: number;
  r: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  weight: number;
  type: DependencyType;
}

interface RawGraphLink {
  source: string;
  target: string;
  weight: number;
  type: DependencyType;
}

type HubTier = 0 | 1 | 2;

interface LayoutTarget {
  x: number;
  y: number;
}

interface SupernodeState {
  tierById: Map<string, HubTier>;
  scoreById: Map<string, number>;
  layoutTargetById: Map<string, LayoutTarget>;
  anchorStrengthById: Map<string, number>;
}

interface ResolvedLink {
  index: number;
  srcId: string;
  tgtId: string;
  weight: number;
  type: DependencyType;
  srcTier: HubTier;
  tgtTier: HubTier;
}

type FocusMode = "all" | "hub" | "neighborhood";
type WeakEdgePreset = "off" | "3" | "5" | "8";

interface ContagionGraphProps {
  cards: ReportCard[];
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIDTH = 800;
const HEIGHT = 600;
const PAD = 44; // inner padding so nothing touches the border
const MAX_NODES = 50;
const MIN_RADIUS = 10;
const MAX_RADIUS = 34;
const RING_WIDTH = 3;
const HUB_LABEL_FONT_SIZE = 11;
const CORE_PAIR_X_JITTER = 12;
const CORE_PAIR_Y_OFFSET = 118;
const CORE_RING_RADIUS_X = 102;
const CORE_RING_RADIUS_Y = 74;
const TIER2_RING_RADIUS_X = 214;
const TIER2_RING_RADIUS_Y = 154;
const CORE_LANE_HALF_WIDTH = 56;
const CORE_LANE_MARGIN = 10;

const SUPERNODE_CONFIG = {
  // Score weights
  weightInWeight: 0.5,
  weightInDegree: 0.25,
  weightTotalDegree: 0.15,
  weightMcap: 0.1,

  // Entry thresholds
  corePercentile: 0.9,
  secondaryPercentile: 0.75,

  // Hysteresis hold thresholds
  coreHoldPercentile: 0.8,
  secondaryHoldPercentile: 0.65,

  // Tier gate minimums
  minCoreInDegree: 2,
  minSecondaryInDegree: 1,
  minSecondaryInWeight: 0.1,

  // Tier clamps
  minTier1: 2,
  maxTier1: 3,
  minTier2: 3,
  maxTier2: 5,

  // Sparse fallback
  sparseEdgeCutoff: 12,
  sparseTier1Count: 2,
} as const;

const TYPE_COLORS: Record<string, string> = {
  collateral: "#64748b",
  mechanism: "#f59e0b",
  wrapper: "#8b5cf6",
};

const TYPE_DASH: Record<string, string | undefined> = {
  collateral: undefined,
  mechanism: "6 3",
  wrapper: "2 3",
};

const WEAK_EDGE_THRESHOLD_BY_PRESET: Record<WeakEdgePreset, number> = {
  off: 0,
  "3": 0.03,
  "5": 0.05,
  "8": 0.08,
};

function gradeColor(grade: string): string {
  return GRADE_RADAR_COLORS[gradeRange(grade as ReportCardGrade)] ?? GRADE_RADAR_COLORS.NR;
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * t;
}

function minMaxNormalize(ids: string[], valueById: Map<string, number>): Map<string, number> {
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

function deterministicJitter(id: string, salt: number, range: number): number {
  let hash = salt;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 33 + id.charCodeAt(i)) >>> 0;
  }
  return ((hash % 1000) / 999 - 0.5) * 2 * range;
}

function placeOnEllipse(ids: string[], radiusX: number, radiusY: number, startAngle: number, targetById: Map<string, LayoutTarget>) {
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
) {
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
// Component
// ---------------------------------------------------------------------------

export function ContagionGraph({ cards, mcapMap, logos }: ContagionGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const prevTierByIdRef = useRef<Map<string, HubTier>>(new Map());

  // Prepare graph data
  const { nodes, links } = useMemo(() => {
    const cardMap = new Map(cards.map((c) => [c.id, c]));
    const liveIds = [...cardMap.keys()].filter((id) => !cardMap.get(id)!.isDefunct);
    const liveIdSet = new Set(liveIds);

    const inboundCounts = new Map<string, number>();
    const outboundCounts = new Map<string, number>();
    const liveLinks: RawGraphLink[] = [];

    for (const meta of TRACKED_STABLECOINS) {
      if (!liveIdSet.has(meta.id)) continue;
      const deps = deriveDependencies(meta);
      let outCount = 0;

      for (const dep of deps) {
        if (!liveIdSet.has(dep.id)) continue;
        outCount++;
        inboundCounts.set(dep.id, (inboundCounts.get(dep.id) ?? 0) + 1);
        liveLinks.push({
          source: meta.id,
          target: dep.id,
          weight: dep.weight,
          type: dep.type ?? "collateral",
        });
      }

      if (outCount > 0) outboundCounts.set(meta.id, outCount);
    }

    // Start from coins with at least one live dependency edge in or out,
    // ranked by market cap.
    const rankedIds = liveIds
      .filter((id) => (inboundCounts.get(id) ?? 0) > 0 || (outboundCounts.get(id) ?? 0) > 0)
      .sort((a, b) => (mcapMap.get(b) ?? 0) - (mcapMap.get(a) ?? 0));

    // Keep up to MAX_NODES, but prune any node that is isolated inside the
    // displayed subset and backfill from lower-ranked connected candidates.
    let selectedIds = rankedIds.slice(0, MAX_NODES);
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

      while (selectedIds.length < MAX_NODES && nextCandidateIdx < rankedIds.length) {
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
      return { id, symbol: card.symbol, grade: card.overallGrade, mcap, r };
    });

    const graphLinks: GraphLink[] = selectedLinks;

    return { nodes: graphNodes, links: graphLinks };
  }, [cards, mcapMap]);

  const supernodeState = useMemo<SupernodeState>(() => {
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

    const pCoreEnter = percentile(scores, SUPERNODE_CONFIG.corePercentile);
    const pCoreHold = percentile(scores, SUPERNODE_CONFIG.coreHoldPercentile);
    const pSecondaryEnter = percentile(scores, SUPERNODE_CONFIG.secondaryPercentile);
    const pSecondaryHold = percentile(scores, SUPERNODE_CONFIG.secondaryHoldPercentile);

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
        // eslint-disable-next-line react-hooks/refs -- read-only hysteresis snapshot from previous render.
        const prevTier = prevTierByIdRef.current.get(id) ?? 0;

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
  }, [nodes, links]);

  useEffect(() => {
    prevTierByIdRef.current = new Map(supernodeState.tierById);
  }, [supernodeState.tierById]);

  const [focusMode, setFocusMode] = useState<FocusMode>("all");
  const [weakEdgePreset, setWeakEdgePreset] = useState<WeakEdgePreset>("5");
  const [selectedNeighborhoodId, setSelectedNeighborhoodId] = useState<string | null>(null);

  const weakEdgeThreshold = WEAK_EDGE_THRESHOLD_BY_PRESET[weakEdgePreset];

  const hubIdsByScore = useMemo(
    () => [...nodes]
      .filter((n) => (supernodeState.tierById.get(n.id) ?? 0) > 0)
      .sort((a, b) => (supernodeState.scoreById.get(b.id) ?? 0) - (supernodeState.scoreById.get(a.id) ?? 0))
      .map((n) => n.id),
    [nodes, supernodeState.scoreById, supernodeState.tierById],
  );

  const nodeSelectOptions = useMemo(
    () => [...nodes]
      .sort((a, b) => b.mcap - a.mcap)
      .map((n) => ({ id: n.id, symbol: n.symbol, mcap: n.mcap })),
    [nodes],
  );

  useEffect(() => {
    if (!nodes.length) {
      setSelectedNeighborhoodId(null);
      return;
    }

    setSelectedNeighborhoodId((prev) => {
      if (prev && nodes.some((n) => n.id === prev)) return prev;
      return hubIdsByScore[0] ?? nodes[0].id;
    });
  }, [nodes, hubIdsByScore]);

  // Fast node lookup by id (avoids O(n) find inside render loops)
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Run simulation
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    if (nodes.length === 0) return;

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

    // Stronger repulsion scaled by node size — big nodes claim more space
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

    // Post-simulation overlap resolution.
    // Boundaries are treated like immovable walls inside the same loop as
    // pairwise separation, so displacement propagates inward through the
    // graph instead of ping-ponging between clamp and separate.
    const MAX_PASSES = 100;
    const xMin = PAD;
    const xMax = WIDTH - PAD;
    const yMin = PAD;
    const yMax = HEIGHT - PAD;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let violations = 0;

      // Pairwise separation
      for (let i = 0; i < simNodes.length; i++) {
        for (let j = i + 1; j < simNodes.length; j++) {
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

      // Boundary enforcement — push out-of-bounds nodes inward
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

    setPositions(posMap);
  }, [nodes, links, supernodeState]);

  // Drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const dragStart = useRef<{ mx: number; my: number; nx: number; ny: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgP = pt.matrixTransform(ctm.inverse());
    const pos = positions.get(nodeId);
    if (!pos) return;
    setDragId(nodeId);
    dragStart.current = { mx: svgP.x, my: svgP.y, nx: pos.x, ny: pos.y };
  }, [positions]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragId || !dragStart.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgP = pt.matrixTransform(ctm.inverse());
    const dx = svgP.x - dragStart.current.mx;
    const dy = svgP.y - dragStart.current.my;
    setPositions((prev) => {
      const next = new Map(prev);
      const r = nodeMap.get(dragId)?.r ?? MIN_RADIUS;
      next.set(dragId, {
        x: Math.max(PAD + r, Math.min(WIDTH - PAD - r, dragStart.current!.nx + dx)),
        y: Math.max(PAD + r, Math.min(HEIGHT - PAD - r, dragStart.current!.ny + dy)),
      });
      return next;
    });
  }, [dragId, nodeMap]);

  const handleMouseUp = useCallback(() => {
    setDragId(null);
    dragStart.current = null;
  }, []);

  // Tooltip state
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);

  const neighborhoodFocusId = focusMode === "neighborhood"
    ? (selectedNeighborhoodId ?? hubIdsByScore[0] ?? nodes[0]?.id ?? null)
    : null;

  const resolvedLinks = useMemo<ResolvedLink[]>(
    () => links.map((link, index) => {
      const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
      const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
      return {
        index,
        srcId,
        tgtId,
        weight: link.weight,
        type: link.type,
        srcTier: supernodeState.tierById.get(srcId) ?? 0,
        tgtTier: supernodeState.tierById.get(tgtId) ?? 0,
      };
    }),
    [links, supernodeState.tierById],
  );

  const resolvedLinkByIndex = useMemo(
    () => new Map<number, ResolvedLink>(resolvedLinks.map((l) => [l.index, l])),
    [resolvedLinks],
  );

  const { visibleLinks, visibleLinkIndices, visibleNodeIds, hiddenMinorByNode } = useMemo(() => {
    const scopeNodeIds = new Set<string>();
    const visible = [] as ResolvedLink[];
    const visibleIndices = new Set<number>();
    const hiddenMinor = new Map<string, number>();

    for (const link of resolvedLinks) {
      const inScope = focusMode === "all"
        ? true
        : focusMode === "hub"
          ? (link.srcTier > 0 || link.tgtTier > 0)
          : neighborhoodFocusId !== null
            ? (link.srcId === neighborhoodFocusId || link.tgtId === neighborhoodFocusId)
            : false;
      if (!inScope) continue;

      scopeNodeIds.add(link.srcId);
      scopeNodeIds.add(link.tgtId);

      const touchesHovered = hoveredId !== null && (link.srcId === hoveredId || link.tgtId === hoveredId);
      const touchesNeighborhood = neighborhoodFocusId !== null
        && (link.srcId === neighborhoodFocusId || link.tgtId === neighborhoodFocusId);
      const hideAsWeak = weakEdgeThreshold > 0
        && link.weight < weakEdgeThreshold
        && !touchesHovered
        && !touchesNeighborhood;

      if (hideAsWeak) {
        hiddenMinor.set(link.srcId, (hiddenMinor.get(link.srcId) ?? 0) + 1);
        hiddenMinor.set(link.tgtId, (hiddenMinor.get(link.tgtId) ?? 0) + 1);
        continue;
      }

      visible.push(link);
      visibleIndices.add(link.index);
    }

    const nodeIds = new Set<string>();
    for (const link of visible) {
      nodeIds.add(link.srcId);
      nodeIds.add(link.tgtId);
    }

    if (focusMode === "all") {
      for (const n of nodes) nodeIds.add(n.id);
    } else if (focusMode === "hub") {
      for (const id of scopeNodeIds) nodeIds.add(id);
      for (const id of hubIdsByScore) nodeIds.add(id);
    } else {
      for (const id of scopeNodeIds) nodeIds.add(id);
      if (neighborhoodFocusId) nodeIds.add(neighborhoodFocusId);
    }

    return {
      visibleLinks: visible,
      visibleLinkIndices: visibleIndices,
      visibleNodeIds: nodeIds,
      hiddenMinorByNode: hiddenMinor,
    };
  }, [resolvedLinks, focusMode, neighborhoodFocusId, hoveredId, weakEdgeThreshold, nodes, hubIdsByScore]);

  useEffect(() => {
    if (hoveredEdge !== null && !visibleLinkIndices.has(hoveredEdge)) setHoveredEdge(null);
  }, [hoveredEdge, visibleLinkIndices]);

  useEffect(() => {
    if (hoveredId !== null && !visibleNodeIds.has(hoveredId)) setHoveredId(null);
  }, [hoveredId, visibleNodeIds]);

  // Compute connected nodes/edges for node-hover spotlight
  const { connectedNodes, connectedEdges } = useMemo(() => {
    if (!hoveredId) return { connectedNodes: new Set<string>(), connectedEdges: new Set<number>() };
    const cNodes = new Set<string>();
    const cEdges = new Set<number>();
    for (const link of visibleLinks) {
      if (link.srcId === hoveredId || link.tgtId === hoveredId) {
        cNodes.add(link.srcId);
        cNodes.add(link.tgtId);
        cEdges.add(link.index);
      }
    }
    return { connectedNodes: cNodes, connectedEdges: cEdges };
  }, [hoveredId, visibleLinks]);

  if (nodes.length === 0) return null;

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <p className="text-xs text-muted-foreground">
          Showing {visibleNodeIds.size} of {nodes.length} dependency-linked stablecoins with {visibleLinks.length} visible edges.
          Adaptive supernode emphasis keeps key hubs centered and their links visually prioritized.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-[10px] text-muted-foreground">Focus</span>
          <ToggleGroup
            type="single"
            value={focusMode}
            onValueChange={(v) => { if (v) setFocusMode(v as FocusMode); }}
            variant="outline"
            size="sm"
            className="h-7"
          >
            <ToggleGroupItem value="all" className="text-[10px]">All</ToggleGroupItem>
            <ToggleGroupItem value="hub" className="text-[10px]">Hub dependencies</ToggleGroupItem>
            <ToggleGroupItem value="neighborhood" className="text-[10px]">Selected neighborhood</ToggleGroupItem>
          </ToggleGroup>

          <span className="text-[10px] text-muted-foreground">Min edge</span>
          <ToggleGroup
            type="single"
            value={weakEdgePreset}
            onValueChange={(v) => { if (v) setWeakEdgePreset(v as WeakEdgePreset); }}
            variant="outline"
            size="sm"
            className="h-7"
          >
            <ToggleGroupItem value="off" className="text-[10px]">Off</ToggleGroupItem>
            <ToggleGroupItem value="3" className="text-[10px]">3%</ToggleGroupItem>
            <ToggleGroupItem value="5" className="text-[10px]">5%</ToggleGroupItem>
            <ToggleGroupItem value="8" className="text-[10px]">8%</ToggleGroupItem>
          </ToggleGroup>

          {focusMode === "neighborhood" && (
            <div className="ml-auto flex flex-col items-end gap-1">
              <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                Coin
                <select
                  className="h-7 rounded-md border bg-background px-2 text-[11px] text-foreground"
                  value={neighborhoodFocusId ?? ""}
                  onChange={(e) => setSelectedNeighborhoodId(e.target.value || null)}
                >
                  {nodeSelectOptions.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.symbol}
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-[10px] text-muted-foreground">Click any node to set neighborhood</span>
            </div>
          )}
        </div>
        {/* Horizontal legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
          {[
            { label: "Grade A", color: GRADE_RADAR_COLORS.A },
            { label: "Grade B", color: GRADE_RADAR_COLORS.B },
            { label: "Grade C", color: GRADE_RADAR_COLORS.C },
            { label: "Grade D", color: GRADE_RADAR_COLORS.D },
            { label: "Grade F", color: GRADE_RADAR_COLORS.F },
          ].map(({ label, color }) => (
            <span key={label} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: color, backgroundColor: "var(--color-card, #1a1a2e)" }} />
              {label}
            </span>
          ))}
          <span className="mx-1 text-border">|</span>
          {(["collateral", "mechanism", "wrapper"] as const).map((type) => (
            <span key={type} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <svg width="16" height="6" className="shrink-0">
                <line x1="0" y1="3" x2="16" y2="3" stroke={TYPE_COLORS[type]} strokeWidth={2} strokeDasharray={TYPE_DASH[type]} />
              </svg>
              {type[0].toUpperCase() + type.slice(1)}
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div
          className="w-full overflow-hidden rounded-lg border bg-background/50"
          role="figure"
          aria-label={`Dependency graph showing ${visibleNodeIds.size} visible stablecoins and ${visibleLinks.length} visible dependency connections`}
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="w-full"
            style={{ cursor: dragId ? "grabbing" : "default" }}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* Clip paths for circular logo masking + arrowhead markers */}
            <defs>
              {nodes.map((node) => {
                const pos = positions.get(node.id);
                if (!pos) return null;
                const innerR = node.r - RING_WIDTH;
                return (
                  <clipPath key={node.id} id={`clip-n-${node.id}`}>
                    <circle cx={pos.x} cy={pos.y} r={innerR} />
                  </clipPath>
                );
              })}
            </defs>

            {/* Edges */}
            {visibleLinks.map((link) => {
              const srcId = link.srcId;
              const tgtId = link.tgtId;
              const posA = positions.get(srcId);
              const posB = positions.get(tgtId);
              if (!posA || !posB) return null;

              const isEdgeDirectHovered = hoveredEdge === link.index;
              const isConnected = connectedEdges.has(link.index);
              const isNodeHovered = !!hoveredId;
              const srcTier = link.srcTier;
              const tgtTier = link.tgtTier;
              const isHubEdge = srcTier > 0 || tgtTier > 0;
              const isCoreHubEdge = srcTier === 2 || tgtTier === 2;

              const swBase = 1 + link.weight * 5;
              const sw = swBase * (isCoreHubEdge ? 1.2 : isHubEdge ? 1.05 : 0.85);
              const soBase = 0.12 + link.weight * (isHubEdge ? 0.52 : 0.34);
              const so = isCoreHubEdge ? Math.min(0.92, soBase + 0.14) : soBase;
              const defaultOpacity = isCoreHubEdge ? so : isHubEdge ? so * 0.82 : so * 0.46;

              const typeColor = TYPE_COLORS[link.type];
              const dashArray = TYPE_DASH[link.type];

              const edgeOpacity = isNodeHovered && !isConnected && !isEdgeDirectHovered
                ? 0.05
                : isEdgeDirectHovered ? 0.9 : defaultOpacity;

              return (
                <g key={`${srcId}-${tgtId}-${link.index}`}>
                  {/* Invisible wide hit area */}
                  <line
                    x1={posA.x} y1={posA.y} x2={posB.x} y2={posB.y}
                    stroke="transparent" strokeWidth={14}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setHoveredEdge(link.index)}
                    onMouseLeave={() => setHoveredEdge(null)}
                  />
                  {/* Visible edge */}
                  <line
                    x1={posA.x} y1={posA.y} x2={posB.x} y2={posB.y}
                    stroke={typeColor}
                    strokeWidth={isEdgeDirectHovered ? sw + 1 : sw}
                    opacity={edgeOpacity}
                    strokeDasharray={dashArray}
                    pointerEvents="none"
                  />
                </g>
              );
            })}

            {/* Nodes: logo clipped to circle + grade-colored ring */}
            {nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => {
              const pos = positions.get(node.id);
              if (!pos) return null;
              const isHovered = hoveredId === node.id;
              const isNodeDimmed = hoveredId !== null && hoveredId !== node.id && !connectedNodes.has(node.id);
              const tier = supernodeState.tierById.get(node.id) ?? 0;
              const isHub = tier > 0;
              const isCoreHub = tier === 2;
              const hiddenMinorCount = hiddenMinorByNode.get(node.id) ?? 0;
              const color = gradeColor(node.grade);
              const innerR = node.r - RING_WIDTH;
              const logoUrl = logos?.[node.id];
              const hubLabelY = Math.max(PAD + 10, Math.min(HEIGHT - PAD - 2, pos.y + node.r + (isCoreHub ? 12 : 10)));

              return (
                <g
                  key={node.id}
                  style={{ cursor: focusMode === "neighborhood" ? "pointer" : "grab" }}
                  onMouseDown={(e) => handleMouseDown(e, node.id)}
                  onMouseEnter={() => { setHoveredId(node.id); setHoveredEdge(null); }}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => {
                    if (dragId) return;
                    if (focusMode === "neighborhood") {
                      setSelectedNeighborhoodId(node.id);
                    }
                  }}
                >
                  {/* Grade-colored ring */}
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={node.r}
                    fill={logoUrl ? "var(--color-card, #1a1a2e)" : color}
                    fillOpacity={logoUrl ? 1 : 0.6}
                    stroke={color}
                    strokeWidth={RING_WIDTH + (isCoreHub ? 1.2 : isHub ? 0.8 : 0)}
                    opacity={isNodeDimmed ? 0.4 : (isHovered ? 1 : 0.85)}
                  />

                  {isCoreHub && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={node.r + 2.5}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.4}
                      opacity={0.55}
                    />
                  )}

                  {/* Logo image (clipped to circle) or text fallback */}
                  {logoUrl ? (
                    <image
                      href={logoUrl}
                      x={pos.x - innerR}
                      y={pos.y - innerR}
                      width={innerR * 2}
                      height={innerR * 2}
                      clipPath={`url(#clip-n-${node.id})`}
                      preserveAspectRatio="xMidYMid slice"
                      pointerEvents="none"
                    />
                  ) : (
                    (node.r >= 12 && (isHovered || isHub)) && (
                      <text
                        x={pos.x}
                        y={pos.y + 1}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="white"
                        fontSize={Math.min(10, node.r * 0.65)}
                        fontWeight={600}
                        pointerEvents="none"
                      >
                        {node.symbol.length > 5 ? node.symbol.slice(0, 4) : node.symbol}
                      </text>
                    )
                  )}

                  {/* Hover highlight ring */}
                  {isHovered && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={node.r + 2}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      opacity={0.6}
                    />
                  )}

                  {isHub && (
                    <text
                      x={pos.x}
                      y={hubLabelY}
                      textAnchor="middle"
                      fill="white"
                      fontSize={isCoreHub ? HUB_LABEL_FONT_SIZE : HUB_LABEL_FONT_SIZE - 1}
                      fontWeight={isCoreHub ? 700 : 600}
                      stroke="rgba(0,0,0,0.82)"
                      strokeWidth={2.4}
                      paintOrder="stroke"
                      pointerEvents="none"
                    >
                      {node.symbol}
                    </text>
                  )}

                  {hiddenMinorCount > 0 && weakEdgeThreshold > 0 && (
                    <g pointerEvents="none">
                      <circle
                        cx={pos.x + node.r * 0.72}
                        cy={pos.y - node.r * 0.66}
                        r={6.2}
                        fill="var(--color-card, #1a1a2e)"
                        stroke="var(--color-border, #334155)"
                        strokeWidth={1}
                        opacity={0.95}
                      />
                      <text
                        x={pos.x + node.r * 0.72}
                        y={pos.y - node.r * 0.66 + 0.5}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="currentColor"
                        fontSize={8}
                        fontWeight={700}
                      >
                        +{hiddenMinorCount}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {/* Node Tooltip (only when no edge is hovered) */}
            {hoveredId && hoveredEdge === null && (() => {
              const node = nodeMap.get(hoveredId);
              const pos = positions.get(hoveredId);
              if (!node || !pos) return null;
              const card = cards.find((c) => c.id === hoveredId);

              const tx = Math.min(pos.x + node.r + 8, WIDTH - 135);
              const ty = Math.max(PAD, pos.y - 20);

              return (
                <g pointerEvents="none">
                  <rect
                    x={tx}
                    y={ty}
                    width={125}
                    height={52}
                    rx={6}
                    fill="var(--color-card, #1c1c1c)"
                    stroke="var(--color-border, #333)"
                    strokeWidth={1}
                  />
                  <text x={tx + 8} y={ty + 18} fill="currentColor" fontSize={12} fontWeight={600}>
                    {node.symbol}
                  </text>
                  <text x={tx + 8} y={ty + 34} fill="currentColor" fontSize={10} opacity={0.7}>
                    Grade: {card?.overallGrade ?? "NR"}
                  </text>
                  <text x={tx + 8} y={ty + 46} fill="currentColor" fontSize={10} opacity={0.7} fontFamily="var(--font-mono, monospace)">
                    {node.mcap > 1e9
                      ? `$${(node.mcap / 1e9).toFixed(1)}B`
                      : node.mcap > 1e6
                        ? `$${(node.mcap / 1e6).toFixed(0)}M`
                        : `$${(node.mcap / 1e3).toFixed(0)}K`}
                  </text>
                </g>
              );
            })()}

            {/* Edge Tooltip */}
            {hoveredEdge !== null && (() => {
              const link = resolvedLinkByIndex.get(hoveredEdge);
              if (!link) return null;
              const srcId = link.srcId;
              const tgtId = link.tgtId;
              const fromPos = positions.get(tgtId);
              const toPos = positions.get(srcId);
              const fromNode = nodeMap.get(tgtId);
              const toNode = nodeMap.get(srcId);
              if (!fromPos || !toPos || !fromNode || !toNode) return null;

              const mx = (fromPos.x + toPos.x) / 2;
              const my = (fromPos.y + toPos.y) / 2;
              const tx = Math.min(Math.max(mx + 8, PAD), WIDTH - 140);
              const ty = Math.min(Math.max(my - 20, PAD), HEIGHT - 44);
              const pctText = `${Math.round(link.weight * 100)}%`;
              const typeLabel = link.type;

              return (
                <g pointerEvents="none">
                  <rect x={tx} y={ty} width={130} height={38} rx={6}
                    fill="var(--color-card, #1c1c1c)" stroke="var(--color-border, #333)" strokeWidth={1} />
                  <text x={tx + 8} y={ty + 15} fill="currentColor" fontSize={11} fontWeight={600}>
                    {fromNode.symbol} → {toNode.symbol}
                  </text>
                  <text x={tx + 8} y={ty + 30} fill="currentColor" fontSize={10} opacity={0.7}>
                    {pctText} · {typeLabel}
                  </text>
                </g>
              );
            })()}

          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
