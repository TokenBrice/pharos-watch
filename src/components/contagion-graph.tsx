"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  computeRippleState,
  computeVisibleGraph,
  findDirectionalNeighbor,
  resolveGraphLinks,
  type FocusMode,
  type ResolvedLink,
} from "@/components/contagion-graph-graph";
import {
  buildGraphData,
  buildSupernodeState,
  runSimulation,
  WIDTH,
  HEIGHT,
  PAD,
  RING_WIDTH,
  HUB_LABEL_FONT_SIZE,
  type HubTier,
  type SupernodeState,
} from "@/lib/contagion-layout";
import { formatCurrency } from "@shared/lib/format";
import { GRADE_RADAR_COLORS } from "@shared/lib/report-cards";
import { gradeColor, TYPE_COLORS, TYPE_DASH } from "@/components/contagion-graph-model";
import {
  buildEdgeTooltipElement,
  buildNodeTooltipElement,
  buildTooltipAnnouncement,
} from "@/components/contagion-graph-tooltips";
import { useContagionGraphDrag } from "@/hooks/use-contagion-graph-drag";
import type { ReportCard, ReportCardsResponse } from "@shared/types";

interface ContagionGraphProps {
  cards: ReportCard[];
  dependencyEdges?: ReportCardsResponse["dependencyGraph"]["edges"];
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContagionGraph({ cards, dependencyEdges, mcapMap, logos }: ContagionGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const prevTierByIdRef = useRef<Map<string, HubTier>>(new Map());

  // Prepare graph data
  const { nodes, links } = useMemo(
    () => buildGraphData(cards, mcapMap, dependencyEdges),
    [cards, dependencyEdges, mcapMap],
  );

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
  const effectiveSelectedNeighborhoodId = useMemo(() => {
    if (!nodes.length) return null;
    if (selectedNeighborhoodId && nodes.some((node) => node.id === selectedNeighborhoodId)) {
      return selectedNeighborhoodId;
    }
    return hubIdsByScore[0] ?? nodes[0].id;
  }, [nodes, hubIdsByScore, selectedNeighborhoodId]);

  // Fast node lookup by id (avoids O(n) find inside render loops)
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const basePositions = useMemo(
    () => (nodes.length === 0 ? new Map<string, { x: number; y: number }>() : runSimulation(nodes, links, supernodeState)),
    [nodes, links, supernodeState],
  );
  const simulationKey = useMemo(
    () => [
      nodes.map((node) => node.id).join("|"),
      links.length,
      [...supernodeState.tierById.entries()].map(([id, tier]) => `${id}:${tier}`).join("|"),
    ].join("::"),
    [nodes, links.length, supernodeState.tierById],
  );
  const {
    dragId,
    positions,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  } = useContagionGraphDrag({
    svgRef,
    nodeMap,
    basePositions,
    simulationKey,
  });

  // Tooltip state
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const resolvedLinks = useMemo(
    () => resolveGraphLinks(links, supernodeState.tierById),
    [links, supernodeState.tierById],
  );

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
    const bestId = findDirectionalNeighbor({
      nodeId,
      direction: e.key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
      links: resolvedLinks,
      positions,
    });

    if (bestId) {
      const target = svgRef.current?.querySelector(`[data-node-id="${bestId}"]`) as HTMLElement | null;
      target?.focus();
    }
  }, [focusMode, positions, resolvedLinks, setSelectedNeighborhoodId]);

  const neighborhoodFocusId = focusMode === "neighborhood"
    ? effectiveSelectedNeighborhoodId
    : null;

  const resolvedLinkByIndex = useMemo(
    () => new Map<number, ResolvedLink>(resolvedLinks.map((l) => [l.index, l])),
    [resolvedLinks],
  );

  const { visibleLinks, visibleLinkIndices, visibleNodeIds } = useMemo(
    () => computeVisibleGraph({
      resolvedLinks,
      focusMode,
      neighborhoodFocusId,
      nodes,
      hubIdsByScore,
    }),
    [resolvedLinks, focusMode, neighborhoodFocusId, nodes, hubIdsByScore],
  );

  const activeHoveredEdge = hoveredEdge !== null && visibleLinkIndices.has(hoveredEdge)
    ? hoveredEdge
    : null;
  const activeHoveredId = hoveredId !== null && visibleNodeIds.has(hoveredId)
    ? hoveredId
    : null;

  // Compute connected nodes/edges for node-hover spotlight with multi-hop
  // contagion ripple. BFS follows the dependency direction: if the hovered
  // node is collateral (tgtId), contagion ripples to dependents (srcId),
  // then transitively through further dependency chains.  Direct neighbors
  // in both directions are included at distance 1 for visual context.
  const RIPPLE_HOP_DELAY_MS = 100;

  const { connectedNodes, connectedEdges, nodeDistance, edgeDistance } = useMemo(
    () => computeRippleState(activeHoveredId, visibleLinks),
    [activeHoveredId, visibleLinks],
  );

  if (nodes.length === 0) return null;

  const tooltipAnnouncement = buildTooltipAnnouncement({
    activeHoveredId,
    activeHoveredEdge,
    cards,
    nodeMap,
    positions,
    resolvedLinkByIndex,
    width: WIDTH,
    height: HEIGHT,
    pad: PAD,
  });

  const nodeTooltipEl = buildNodeTooltipElement({
    activeHoveredId,
    activeHoveredEdge,
    cards,
    nodeMap,
    positions,
    resolvedLinkByIndex,
    width: WIDTH,
    height: HEIGHT,
    pad: PAD,
  });

  const edgeTooltipEl = buildEdgeTooltipElement({
    activeHoveredId,
    activeHoveredEdge,
    cards,
    nodeMap,
    positions,
    resolvedLinkByIndex,
    width: WIDTH,
    height: HEIGHT,
    pad: PAD,
  });

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
                  value={effectiveSelectedNeighborhoodId ?? ""}
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
              <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: color, backgroundColor: "var(--color-card, #f8f9fa)" }} />
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

              const isEdgeDirectHovered = activeHoveredEdge === link.index;
              const isConnected = connectedEdges.has(link.index);
              const isNodeHovered = activeHoveredId !== null;
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
              const isHovered = activeHoveredId === node.id;
              const isNodeDimmed = activeHoveredId !== null && activeHoveredId !== node.id && !connectedNodes.has(node.id);
              const tier = supernodeState.tierById.get(node.id) ?? 0;
              const isHub = tier > 0;
              const isCoreHub = tier === 2;
              const color = gradeColor(node.grade);
              const innerR = node.r - RING_WIDTH;
              const logoUrl = logos?.[node.id];
              const hubLabelY = Math.max(PAD + 10, Math.min(HEIGHT - PAD - 2, pos.y + node.r + (isCoreHub ? 12 : 10)));

              // Contagion ripple: staggered delay based on graph distance
              const hopDist = nodeDistance.get(node.id);
              const isInRipple = activeHoveredId !== null && hopDist != null && hopDist > 0;
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
                    fill={logoUrl ? "var(--color-card, #f8f9fa)" : color}
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
                      stroke="var(--color-card, #f8f9fa)"
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
