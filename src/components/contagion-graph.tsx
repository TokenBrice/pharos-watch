"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  buildGraphData,
  buildSupernodeState,
  runSimulation,
  WIDTH,
  HEIGHT,
  PAD,
  MIN_RADIUS,
  RING_WIDTH,
  HUB_LABEL_FONT_SIZE,
  clampGraphPosition,
  type GraphNode,
  type HubTier,
  type SupernodeState,
} from "@/lib/contagion-layout";
import { formatCurrency } from "@shared/lib/format";
import { GRADE_RADAR_COLORS, gradeRange } from "@shared/lib/report-cards";
import type { DependencyType, ReportCard, ReportCardGrade } from "@shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface ContagionGraphProps {
  cards: ReportCard[];
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<DependencyType, string> = {
  collateral: "#64748b",
  mechanism: "#f59e0b",
  wrapper: "#8b5cf6",
};

const TYPE_DASH: Record<DependencyType, string | undefined> = {
  collateral: undefined,
  mechanism: "6 3",
  wrapper: "2 3",
};


function gradeColor(grade: string): string {
  return GRADE_RADAR_COLORS[gradeRange(grade as ReportCardGrade)] ?? GRADE_RADAR_COLORS.NR;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContagionGraph({ cards, mcapMap, logos }: ContagionGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const prevTierByIdRef = useRef<Map<string, HubTier>>(new Map());



  // Prepare graph data
  const { nodes, links } = useMemo(() => buildGraphData(cards, mcapMap), [cards, mcapMap]);

  const supernodeState = useMemo<SupernodeState>(
    // eslint-disable-next-line react-hooks/refs -- read-only hysteresis snapshot from previous render
    () => buildSupernodeState(nodes, links, prevTierByIdRef.current),
    [nodes, links],
  );

  useEffect(() => {
    prevTierByIdRef.current = new Map(supernodeState.tierById);
  }, [supernodeState.tierById]);

  const [focusMode, setFocusMode] = useState<FocusMode>("all");
  const [selectedNeighborhoodId, setSelectedNeighborhoodId] = useState<string | null>(null);

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
    setPositions(runSimulation(nodes, links, supernodeState));
  }, [nodes, links, supernodeState]);

  // Drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const dragStart = useRef<{ mx: number; my: number; nx: number; ny: number } | null>(null);

  const projectClientPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    if (!e.isPrimary) return;
    e.preventDefault();
    const svgP = projectClientPoint(e.clientX, e.clientY);
    if (!svgP) return;
    const pos = positions.get(nodeId);
    if (!pos) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragId(nodeId);
    dragStart.current = { mx: svgP.x, my: svgP.y, nx: pos.x, ny: pos.y };
  }, [positions, projectClientPoint]);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragId || !dragStart.current) return;
    const svgP = projectClientPoint(e.clientX, e.clientY);
    if (!svgP) return;
    const dx = svgP.x - dragStart.current.mx;
    const dy = svgP.y - dragStart.current.my;
    setPositions((prev) => {
      const next = new Map(prev);
      const r = nodeMap.get(dragId)?.r ?? MIN_RADIUS;
      next.set(dragId, clampGraphPosition(dragStart.current!.nx + dx, dragStart.current!.ny + dy, r));
      return next;
    });
  }, [dragId, nodeMap, projectClientPoint]);

  const handlePointerUp = useCallback(() => {
    setDragId(null);
    dragStart.current = null;
  }, []);

  // Tooltip state
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Keyboard navigation for graph nodes
  const handleNodeKeyDown = useCallback((e: React.KeyboardEvent, nodeId: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (focusMode === "neighborhood") {
        setSelectedNeighborhoodId(nodeId);
      }
      setHoveredId((prev) => (prev === nodeId ? null : nodeId));
      return;
    }

    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();

    // Find connected nodes via links
    const connectedIds = new Set<string>();
    for (const link of links) {
      const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
      const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
      if (srcId === nodeId) connectedIds.add(tgtId);
      if (tgtId === nodeId) connectedIds.add(srcId);
    }

    if (connectedIds.size === 0) return;

    const currentPos = positions.get(nodeId);
    if (!currentPos) return;

    // Find the best neighbor in the arrow key direction
    let bestId: string | null = null;
    let bestScore = -Infinity;

    for (const cId of connectedIds) {
      const cPos = positions.get(cId);
      if (!cPos) continue;
      const dx = cPos.x - currentPos.x;
      const dy = cPos.y - currentPos.y;
      let score = 0;
      switch (e.key) {
        case "ArrowRight": score = dx; break;
        case "ArrowLeft": score = -dx; break;
        case "ArrowDown": score = dy; break;
        case "ArrowUp": score = -dy; break;
      }
      if (score > 0 && score > bestScore) {
        bestScore = score;
        bestId = cId;
      }
    }

    if (bestId) {
      const target = svgRef.current?.querySelector(`[data-node-id="${bestId}"]`) as HTMLElement | null;
      target?.focus();
    }
  }, [focusMode, links, positions, setSelectedNeighborhoodId]);

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

  const { visibleLinks, visibleLinkIndices, visibleNodeIds } = useMemo(() => {
    const scopeNodeIds = new Set<string>();
    const visible = [] as ResolvedLink[];
    const visibleIndices = new Set<number>();

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
    };
  }, [resolvedLinks, focusMode, neighborhoodFocusId, nodes, hubIdsByScore]);

  useEffect(() => {
    if (hoveredEdge !== null && !visibleLinkIndices.has(hoveredEdge)) setHoveredEdge(null);
  }, [hoveredEdge, visibleLinkIndices]);

  useEffect(() => {
    if (hoveredId !== null && !visibleNodeIds.has(hoveredId)) setHoveredId(null);
  }, [hoveredId, visibleNodeIds]);

  // Compute connected nodes/edges for node-hover spotlight with multi-hop
  // contagion ripple. BFS follows the dependency direction: if the hovered
  // node is collateral (tgtId), contagion ripples to dependents (srcId),
  // then transitively through further dependency chains.  Direct neighbors
  // in both directions are included at distance 1 for visual context.
  const MAX_RIPPLE_HOPS = 4;
  const RIPPLE_HOP_DELAY_MS = 100;

  const { connectedNodes, connectedEdges, nodeDistance, edgeDistance } = useMemo(() => {
    const emptyResult = {
      connectedNodes: new Set<string>(),
      connectedEdges: new Set<number>(),
      nodeDistance: new Map<string, number>(),
      edgeDistance: new Map<number, number>(),
    };
    if (!hoveredId) return emptyResult;

    // Build adjacency: downstream = edges where node is target (dependents)
    const downstreamByTarget = new Map<string, ResolvedLink[]>();
    // Also track direct connections in both directions for distance-1
    const directByNode = new Map<string, ResolvedLink[]>();

    for (const link of visibleLinks) {
      // Downstream: hovered is collateral (tgtId), dependents are srcId
      let list = downstreamByTarget.get(link.tgtId);
      if (!list) { list = []; downstreamByTarget.set(link.tgtId, list); }
      list.push(link);

      // Direct connections (both directions)
      let srcList = directByNode.get(link.srcId);
      if (!srcList) { srcList = []; directByNode.set(link.srcId, srcList); }
      srcList.push(link);

      let tgtList = directByNode.get(link.tgtId);
      if (!tgtList) { tgtList = []; directByNode.set(link.tgtId, tgtList); }
      tgtList.push(link);
    }

    const nodeDist = new Map<string, number>();
    const edgeDist = new Map<number, number>();
    nodeDist.set(hoveredId, 0);

    // Distance 1: all direct neighbors (both directions)
    const directLinks = directByNode.get(hoveredId) ?? [];
    for (const link of directLinks) {
      const neighborId = link.srcId === hoveredId ? link.tgtId : link.srcId;
      if (!nodeDist.has(neighborId)) nodeDist.set(neighborId, 1);
      if (!edgeDist.has(link.index)) edgeDist.set(link.index, 1);
    }

    // BFS for downstream contagion (hops 2+): from each downstream node at
    // distance d, follow further downstream edges to distance d+1
    const queue: string[] = [];
    const queued = new Set<string>();

    // Seed BFS with downstream neighbors at distance 1
    const downstreamFromHovered = downstreamByTarget.get(hoveredId) ?? [];
    for (const link of downstreamFromHovered) {
      if (!queued.has(link.srcId)) {
        queued.add(link.srcId);
        queue.push(link.srcId);
      }
    }

    let queueStart = 0;
    while (queueStart < queue.length) {
      const nodeId = queue[queueStart++];
      const currentDist = nodeDist.get(nodeId) ?? 1;
      if (currentDist >= MAX_RIPPLE_HOPS) continue;

      const nextDist = currentDist + 1;
      const downstream = downstreamByTarget.get(nodeId) ?? [];
      for (const link of downstream) {
        if (!edgeDist.has(link.index)) edgeDist.set(link.index, nextDist);
        if (!nodeDist.has(link.srcId)) {
          nodeDist.set(link.srcId, nextDist);
          queue.push(link.srcId);
        }
      }
    }

    const cNodes = new Set<string>(nodeDist.keys());
    const cEdges = new Set<number>(edgeDist.keys());

    return { connectedNodes: cNodes, connectedEdges: cEdges, nodeDistance: nodeDist, edgeDistance: edgeDist };
  }, [hoveredId, visibleLinks]);

  if (nodes.length === 0) return null;

  // Screen-reader tooltip announcement (polite live region)
  const tooltipAnnouncement = (() => {
    if (hoveredEdge !== null) {
      const link = resolvedLinkByIndex.get(hoveredEdge);
      if (!link) return "";
      const fromNode = nodeMap.get(link.tgtId);
      const toNode = nodeMap.get(link.srcId);
      if (!fromNode || !toNode) return "";
      return `${fromNode.symbol} to ${toNode.symbol}, ${Math.round(link.weight * 100)}% ${link.type} dependency`;
    }
    if (hoveredId) {
      const node = nodeMap.get(hoveredId);
      const card = cards.find((c) => c.id === hoveredId);
      if (!node) return "";
      return `${node.symbol}, Grade ${card?.overallGrade ?? "NR"}, market cap ${formatCurrency(node.mcap)}`;
    }
    return "";
  })();

  // Pre-compute tooltip elements for cleaner JSX
  const nodeTooltipEl = (() => {
    if (!hoveredId || hoveredEdge !== null) return null;
    const node = nodeMap.get(hoveredId);
    const pos = positions.get(hoveredId);
    if (!node || !pos) return null;
    const card = cards.find((c) => c.id === hoveredId);
    const tx = Math.min(pos.x + node.r + 8, WIDTH - 135);
    const ty = Math.max(PAD, pos.y - 20);
    return (
      <g pointerEvents="none">
        <rect x={tx} y={ty} width={125} height={52} rx={6}
          fill="var(--color-card, #1a1a2e)" stroke="var(--color-border, #333)" strokeWidth={1} />
        <text x={tx + 8} y={ty + 18} fill="currentColor" fontSize={12} fontWeight={600}>
          {node.symbol}
        </text>
        <text x={tx + 8} y={ty + 34} fill="currentColor" fontSize={10} opacity={0.7}>
          Grade: {card?.overallGrade ?? "NR"}
        </text>
        <text x={tx + 8} y={ty + 46} fill="currentColor" fontSize={10} opacity={0.7} fontFamily="var(--font-mono, monospace)">
          {formatCurrency(node.mcap)}
        </text>
      </g>
    );
  })();

  const edgeTooltipEl = (() => {
    if (hoveredEdge === null) return null;
    const link = resolvedLinkByIndex.get(hoveredEdge);
    if (!link) return null;
    const fromPos = positions.get(link.tgtId);
    const toPos = positions.get(link.srcId);
    const fromNode = nodeMap.get(link.tgtId);
    const toNode = nodeMap.get(link.srcId);
    if (!fromPos || !toPos || !fromNode || !toNode) return null;
    const mx = (fromPos.x + toPos.x) / 2;
    const my = (fromPos.y + toPos.y) / 2;
    const tx = Math.min(Math.max(mx + 8, PAD), WIDTH - 140);
    const ty = Math.min(Math.max(my - 20, PAD), HEIGHT - 44);
    return (
      <g pointerEvents="none">
        <rect x={tx} y={ty} width={130} height={38} rx={6}
          fill="var(--color-card, #1a1a2e)" stroke="var(--color-border, #333)" strokeWidth={1} />
        <text x={tx + 8} y={ty + 15} fill="currentColor" fontSize={11} fontWeight={600}>
          {fromNode.symbol} → {toNode.symbol}
        </text>
        <text x={tx + 8} y={ty + 30} fill="currentColor" fontSize={10} opacity={0.7}>
          {Math.round(link.weight * 100)}% · {link.type}
        </text>
      </g>
    );
  })();

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <p className="text-xs text-muted-foreground">
          Showing {visibleNodeIds.size} of {nodes.length} dependency-linked stablecoins with {visibleLinks.length} visible edges.
          Adaptive supernode emphasis keeps key hubs centered and their links visually prioritized.
        </p>
        <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <span className="shrink-0 text-[10px] text-muted-foreground">Focus</span>
            <div className="w-0 min-w-0 flex-1 overflow-x-auto sm:w-auto sm:flex-none">
              <ToggleGroup
                type="single"
                value={focusMode}
                onValueChange={(v) => { if (v) setFocusMode(v as FocusMode); }}
                variant="outline"
                size="sm"
                className="inline-flex h-9 min-w-max md:h-7"
              >
                <ToggleGroupItem value="all" className="text-[10px]">All</ToggleGroupItem>
                <ToggleGroupItem value="hub" className="text-[10px]">Hub dependencies</ToggleGroupItem>
                <ToggleGroupItem value="neighborhood" className="text-[10px]">Selected neighborhood</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {focusMode === "neighborhood" && (
            <div className="flex w-full flex-col gap-1 sm:ml-auto sm:w-auto sm:items-end">
              <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                Coin
                <select
                  className="h-9 max-w-full rounded-md border bg-background px-2 text-[11px] text-foreground md:h-7"
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
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
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

              const edgeHopDist = edgeDistance.get(link.index);
              const edgeOpacity = isNodeHovered && !isConnected && !isEdgeDirectHovered
                ? 0.05
                : isEdgeDirectHovered
                  ? 0.9
                  : isConnected
                    // Multi-hop edges fade slightly with distance
                    ? Math.max(0.3, defaultOpacity * (1 - (edgeHopDist ?? 1) * 0.12))
                    : defaultOpacity;

              // Staggered transition delay for contagion ripple
              const edgeDelay = isNodeHovered && isConnected && edgeHopDist != null
                ? edgeHopDist * RIPPLE_HOP_DELAY_MS
                : 0;

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
                    style={{
                      transition: `opacity 200ms var(--motion-ease-standard) ${edgeDelay}ms, stroke-width 160ms var(--motion-ease-standard)`,
                    }}
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
              const color = gradeColor(node.grade);
              const innerR = node.r - RING_WIDTH;
              const logoUrl = logos?.[node.id];
              const hubLabelY = Math.max(PAD + 10, Math.min(HEIGHT - PAD - 2, pos.y + node.r + (isCoreHub ? 12 : 10)));

              // Contagion ripple: staggered delay based on graph distance
              const hopDist = nodeDistance.get(node.id);
              const isInRipple = hoveredId !== null && hopDist != null && hopDist > 0;
              const nodeDelay = isInRipple ? hopDist * RIPPLE_HOP_DELAY_MS : 0;

              // Multi-hop connected nodes get slightly less emphasis further out
              const nodeOpacity = isNodeDimmed
                ? 0.4
                : isHovered
                  ? 1
                  : isInRipple
                    ? Math.max(0.6, 0.95 - (hopDist - 1) * 0.08)
                    : 0.85;

              return (
                <g
                  key={node.id}
                  tabIndex={0}
                  data-node-id={node.id}
                  role="button"
                  aria-label={`${node.symbol} — Grade ${node.grade}, market cap ${formatCurrency(node.mcap)}`}
                  style={{ cursor: focusMode === "neighborhood" ? "pointer" : "grab" }}
                  onPointerDown={(e) => handlePointerDown(e, node.id)}
                  onMouseEnter={() => { setHoveredId(node.id); setHoveredEdge(null); }}
                  onMouseLeave={() => setHoveredId(null)}
                  onFocus={() => { setHoveredId(node.id); setFocusedId(node.id); setHoveredEdge(null); }}
                  onBlur={() => { setHoveredId(null); setFocusedId(null); }}
                  onKeyDown={(e) => handleNodeKeyDown(e, node.id)}
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
                    opacity={nodeOpacity}
                    style={{
                      transition: `opacity 200ms var(--motion-ease-standard) ${nodeDelay}ms`,
                    }}
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
                        fill="currentColor"
                        fontSize={Math.min(10, node.r * 0.65)}
                        fontWeight={600}
                        pointerEvents="none"
                      >
                        {node.symbol.length > 5 ? node.symbol.slice(0, 4) : node.symbol}
                      </text>
                    )
                  )}

                  {/* Highlight ring — dashed for keyboard focus, solid for hover */}
                  {(isHovered || focusedId === node.id) && (
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={node.r + (focusedId === node.id ? 3 : 2)}
                      fill="none"
                      stroke={focusedId === node.id ? "var(--color-ring)" : "currentColor"}
                      strokeWidth={focusedId === node.id ? 2 : 1.5}
                      strokeDasharray={focusedId === node.id ? "4 2" : undefined}
                      opacity={0.6}
                    />
                  )}

                  {isHub && (
                    <text
                      x={pos.x}
                      y={hubLabelY}
                      textAnchor="middle"
                      fill="currentColor"
                      fontSize={isCoreHub ? HUB_LABEL_FONT_SIZE : HUB_LABEL_FONT_SIZE - 1}
                      fontWeight={isCoreHub ? 700 : 600}
                      stroke="var(--color-card, #1a1a2e)"
                      strokeWidth={2.4}
                      paintOrder="stroke"
                      pointerEvents="none"
                    >
                      {node.symbol} · {node.grade}
                    </text>
                  )}

                </g>
              );
            })}

            {/* Tooltips (pre-computed above return) */}
            {nodeTooltipEl}
            {edgeTooltipEl}

          </svg>
        </div>
        {/* Screen reader announcements for tooltip content */}
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {tooltipAnnouncement}
        </div>
      </CardContent>
    </Card>
  );
}
