"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
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

function gradeColor(grade: string): string {
  return GRADE_RADAR_COLORS[gradeRange(grade as ReportCardGrade)] ?? GRADE_RADAR_COLORS.NR;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContagionGraph({ cards, mcapMap, logos }: ContagionGraphProps) {
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement>(null);

  // Prepare graph data
  const { nodes, links } = useMemo(() => {
    const cardMap = new Map(cards.map((c) => [c.id, c]));

    const sortedIds = [...cardMap.keys()]
      .filter((id) => !cardMap.get(id)!.isDefunct)
      .sort((a, b) => (mcapMap.get(b) ?? 0) - (mcapMap.get(a) ?? 0))
      .slice(0, MAX_NODES);

    const idSet = new Set(sortedIds);

    const mcaps = sortedIds.map((id) => mcapMap.get(id) ?? 0);
    const maxMcap = Math.max(...mcaps, 1);

    const graphNodes: GraphNode[] = sortedIds.map((id) => {
      const card = cardMap.get(id)!;
      const mcap = mcapMap.get(id) ?? 0;
      const r = MIN_RADIUS + Math.sqrt(mcap / maxMcap) * (MAX_RADIUS - MIN_RADIUS);
      return { id, symbol: card.symbol, grade: card.overallGrade, mcap, r };
    });

    const graphLinks: GraphLink[] = [];
    for (const meta of TRACKED_STABLECOINS) {
      if (!idSet.has(meta.id)) continue;
      const deps = deriveDependencies(meta);
      for (const dep of deps) {
        if (idSet.has(dep.id)) {
          graphLinks.push({ source: meta.id, target: dep.id, weight: dep.weight, type: dep.type ?? "collateral" });
        }
      }
    }

    return { nodes: graphNodes, links: graphLinks };
  }, [cards, mcapMap]);

  // Fast node lookup by id (avoids O(n) find inside render loops)
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Run simulation
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    if (nodes.length === 0) return;

    const simNodes = nodes.map((n) => ({ ...n }));
    const simLinks = links.map((l) => ({ ...l }));

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
      .force("x", forceX(WIDTH / 2).strength(0.05))
      .force("y", forceY(HEIGHT / 2).strength(0.05))
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
  }, [nodes, links]);

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
    const svgP = pt.matrixTransform(svg.getScreenCTM()!.inverse());
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
    const svgP = pt.matrixTransform(svg.getScreenCTM()!.inverse());
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

  // Compute connected nodes/edges for node-hover spotlight
  const { connectedNodes, connectedEdges } = useMemo(() => {
    if (!hoveredId) return { connectedNodes: new Set<string>(), connectedEdges: new Set<number>() };
    const cNodes = new Set<string>();
    const cEdges = new Set<number>();
    links.forEach((link, i) => {
      const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
      const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
      if (srcId === hoveredId || tgtId === hoveredId) {
        cNodes.add(srcId);
        cNodes.add(tgtId);
        cEdges.add(i);
      }
    });
    return { connectedNodes: cNodes, connectedEdges: cEdges };
  }, [hoveredId, links]);

  if (nodes.length === 0) return null;

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <p className="text-xs text-muted-foreground">
          Top {nodes.length} stablecoins by market cap. Edge thickness shows dependency weight; color and dash encode type. Hover edges for details.
        </p>
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
          aria-label={`Dependency graph showing ${nodes.length} stablecoins with ${links.length} dependency connections`}
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
            {links.map((link, i) => {
              const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
              const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
              const posA = positions.get(srcId);
              const posB = positions.get(tgtId);
              if (!posA || !posB) return null;

              const isEdgeDirectHovered = hoveredEdge === i;
              const isConnected = connectedEdges.has(i);
              const isNodeHovered = !!hoveredId;
              const sw = 1 + link.weight * 5;
              const so = 0.15 + link.weight * 0.45;

              const typeColor = TYPE_COLORS[link.type];
              const dashArray = TYPE_DASH[link.type];

              const edgeOpacity = isNodeHovered && !isConnected && !isEdgeDirectHovered
                ? 0.05
                : isEdgeDirectHovered ? 0.9 : so;

              return (
                <g key={`${srcId}-${tgtId}-${i}`}>
                  {/* Invisible wide hit area */}
                  <line
                    x1={posA.x} y1={posA.y} x2={posB.x} y2={posB.y}
                    stroke="transparent" strokeWidth={14}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => setHoveredEdge(i)}
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
            {nodes.map((node) => {
              const pos = positions.get(node.id);
              if (!pos) return null;
              const isHovered = hoveredId === node.id;
              const isNodeDimmed = hoveredId !== null && hoveredId !== node.id && !connectedNodes.has(node.id);
              const color = gradeColor(node.grade);
              const innerR = node.r - RING_WIDTH;
              const logoUrl = logos?.[node.id];

              return (
                <g
                  key={node.id}
                  style={{ cursor: "pointer" }}
                  onMouseDown={(e) => handleMouseDown(e, node.id)}
                  onMouseEnter={() => { setHoveredId(node.id); setHoveredEdge(null); }}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => { if (!dragId) router.push(`/stablecoin/${node.id}`); }}
                >
                  {/* Grade-colored ring */}
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={node.r}
                    fill={logoUrl ? "var(--color-card, #1a1a2e)" : color}
                    fillOpacity={logoUrl ? 1 : 0.6}
                    stroke={color}
                    strokeWidth={RING_WIDTH}
                    opacity={isNodeDimmed ? 0.4 : (isHovered ? 1 : 0.85)}
                  />

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
                    node.r >= 12 && (
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
              const link = links[hoveredEdge];
              if (!link) return null;
              const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
              const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
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
