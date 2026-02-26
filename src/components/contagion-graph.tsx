"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import type { ReportCard } from "@/lib/types";

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
const HEIGHT = 520;
const MAX_NODES = 50;
const MIN_RADIUS = 8;
const MAX_RADIUS = 32;

/** Map grade letter to a fill color hex */
const GRADE_FILL: Record<string, string> = {
  "A+": "#10b981", A: "#10b981", "A-": "#10b981",
  "B+": "#3b82f6", B: "#3b82f6", "B-": "#3b82f6",
  "C+": "#f59e0b", C: "#f59e0b", "C-": "#f59e0b",
  "D+": "#f97316", D: "#f97316", "D-": "#f97316",
  F: "#ef4444",
  NR: "#6b7280",
};

function gradeColor(grade: string): string {
  return GRADE_FILL[grade] ?? GRADE_FILL.NR;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContagionGraph({ cards, mcapMap, logos }: ContagionGraphProps) {
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement>(null);

  // Prepare graph data
  const { nodes, links } = useMemo(() => {
    // Get top coins by mcap that have report cards
    const cardMap = new Map(cards.map((c) => [c.id, c]));

    const sortedIds = [...cardMap.keys()]
      .filter((id) => !cardMap.get(id)!.isDefunct)
      .sort((a, b) => (mcapMap.get(b) ?? 0) - (mcapMap.get(a) ?? 0))
      .slice(0, MAX_NODES);

    const idSet = new Set(sortedIds);

    // Scale mcap to radius
    const mcaps = sortedIds.map((id) => mcapMap.get(id) ?? 0);
    const maxMcap = Math.max(...mcaps, 1);

    const graphNodes: GraphNode[] = sortedIds.map((id) => {
      const card = cardMap.get(id)!;
      const meta = TRACKED_STABLECOINS.find((s) => s.id === id);
      const mcap = mcapMap.get(id) ?? 0;
      const r = MIN_RADIUS + (Math.sqrt(mcap / maxMcap)) * (MAX_RADIUS - MIN_RADIUS);
      return {
        id,
        symbol: card.symbol,
        grade: card.overallGrade,
        mcap,
        r,
      };
    });

    // Build edges from dependency data
    const graphLinks: GraphLink[] = [];
    for (const meta of TRACKED_STABLECOINS) {
      if (!idSet.has(meta.id) || !meta.dependencies) continue;
      for (const dep of meta.dependencies) {
        if (idSet.has(dep.id)) {
          graphLinks.push({
            source: meta.id,
            target: dep.id,
            weight: dep.weight,
          });
        }
      }
    }

    return { nodes: graphNodes, links: graphLinks };
  }, [cards, mcapMap]);

  // Run simulation
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    if (nodes.length === 0) return;

    // Clone nodes so d3 mutation doesn't affect React state
    const simNodes = nodes.map((n) => ({ ...n }));
    const simLinks = links.map((l) => ({ ...l }));

    const sim = forceSimulation(simNodes)
      .force("link", forceLink<GraphNode, GraphLink>(simLinks).id((d) => d.id).distance(80).strength((l) => (l as GraphLink).weight * 0.5))
      .force("charge", forceManyBody().strength(-120))
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      .force("collide", forceCollide<GraphNode>().radius((d) => d.r + 4))
      .stop();

    // Run to completion
    for (let i = 0; i < 300; i++) sim.tick();

    const posMap = new Map<string, { x: number; y: number }>();
    for (const n of simNodes) {
      posMap.set(n.id, {
        x: Math.max(n.r, Math.min(WIDTH - n.r, n.x ?? WIDTH / 2)),
        y: Math.max(n.r, Math.min(HEIGHT - n.r, n.y ?? HEIGHT / 2)),
      });
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
      const node = nodes.find((n) => n.id === dragId);
      const r = node?.r ?? MIN_RADIUS;
      next.set(dragId, {
        x: Math.max(r, Math.min(WIDTH - r, dragStart.current!.nx + dx)),
        y: Math.max(r, Math.min(HEIGHT - r, dragStart.current!.ny + dy)),
      });
      return next;
    });
  }, [dragId, nodes]);

  const handleMouseUp = useCallback(() => {
    setDragId(null);
    dragStart.current = null;
  }, []);

  // Tooltip state
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  if (nodes.length === 0) return null;

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Dependency Map
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Top {nodes.length} stablecoins by market cap. Lines show collateral dependencies. Node size = market cap. Click to view details.
        </p>
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
            {/* Edges */}
            {links.map((link, i) => {
              const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
              const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
              const srcPos = positions.get(srcId);
              const tgtPos = positions.get(tgtId);
              if (!srcPos || !tgtPos) return null;
              return (
                <line
                  key={`${srcId}-${tgtId}-${i}`}
                  x1={srcPos.x}
                  y1={srcPos.y}
                  x2={tgtPos.x}
                  y2={tgtPos.y}
                  stroke="currentColor"
                  strokeWidth={Math.max(1, link.weight * 3)}
                  opacity={0.15}
                />
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => {
              const pos = positions.get(node.id);
              if (!pos) return null;
              const isHovered = hoveredId === node.id;

              return (
                <g
                  key={node.id}
                  style={{ cursor: "pointer" }}
                  onMouseDown={(e) => handleMouseDown(e, node.id)}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => {
                    if (!dragId) router.push(`/stablecoin/${node.id}`);
                  }}
                >
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={node.r}
                    fill={gradeColor(node.grade)}
                    opacity={isHovered ? 0.9 : 0.6}
                    stroke={isHovered ? "currentColor" : "none"}
                    strokeWidth={1.5}
                  />
                  {node.r >= 12 && (
                    <text
                      x={pos.x}
                      y={pos.y + 1}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="white"
                      fontSize={Math.min(10, node.r * 0.7)}
                      fontWeight={600}
                      pointerEvents="none"
                    >
                      {node.symbol.length > 5 ? node.symbol.slice(0, 4) : node.symbol}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Tooltip */}
            {hoveredId && (() => {
              const node = nodes.find((n) => n.id === hoveredId);
              const pos = positions.get(hoveredId);
              if (!node || !pos) return null;
              const card = cards.find((c) => c.id === hoveredId);

              const tx = pos.x + node.r + 8;
              const ty = pos.y - 20;

              return (
                <g pointerEvents="none">
                  <rect
                    x={Math.min(tx, WIDTH - 130)}
                    y={Math.max(0, ty)}
                    width={120}
                    height={52}
                    rx={6}
                    fill="var(--color-card, #1c1c1c)"
                    stroke="var(--color-border, #333)"
                    strokeWidth={1}
                  />
                  <text
                    x={Math.min(tx, WIDTH - 130) + 8}
                    y={Math.max(0, ty) + 18}
                    fill="currentColor"
                    fontSize={12}
                    fontWeight={600}
                  >
                    {node.symbol}
                  </text>
                  <text
                    x={Math.min(tx, WIDTH - 130) + 8}
                    y={Math.max(0, ty) + 34}
                    fill="currentColor"
                    fontSize={10}
                    opacity={0.7}
                  >
                    Grade: {card?.overallGrade ?? "NR"}
                  </text>
                  <text
                    x={Math.min(tx, WIDTH - 130) + 8}
                    y={Math.max(0, ty) + 46}
                    fill="currentColor"
                    fontSize={10}
                    opacity={0.7}
                    fontFamily="var(--font-mono, monospace)"
                  >
                    {node.mcap > 1e9
                      ? `$${(node.mcap / 1e9).toFixed(1)}B`
                      : node.mcap > 1e6
                        ? `$${(node.mcap / 1e6).toFixed(0)}M`
                        : `$${(node.mcap / 1e3).toFixed(0)}K`}
                  </text>
                </g>
              );
            })()}

            {/* Legend */}
            {[
              { label: "A", color: GRADE_FILL["A"] },
              { label: "B", color: GRADE_FILL["B"] },
              { label: "C", color: GRADE_FILL["C"] },
              { label: "D", color: GRADE_FILL["D"] },
              { label: "F", color: GRADE_FILL["F"] },
            ].map(({ label, color }, i) => (
              <g key={label} transform={`translate(${WIDTH - 100}, ${12 + i * 18})`}>
                <circle cx={6} cy={6} r={5} fill={color} opacity={0.6} />
                <text x={16} y={10} fill="currentColor" fontSize={10} opacity={0.6}>
                  Grade {label}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
