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
import { GRADE_RADAR_COLORS, gradeRange } from "@/lib/report-cards";
import type { ReportCard, ReportCardGrade } from "@/lib/types";

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
const PAD = 44; // inner padding so nothing touches the border
const MAX_NODES = 50;
const MIN_RADIUS = 10;
const MAX_RADIUS = 34;
const RING_WIDTH = 3;

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
      if (!idSet.has(meta.id) || !meta.dependencies) continue;
      for (const dep of meta.dependencies) {
        if (idSet.has(dep.id)) {
          graphLinks.push({ source: meta.id, target: dep.id, weight: dep.weight });
        }
      }
    }

    return { nodes: graphNodes, links: graphLinks };
  }, [cards, mcapMap]);

  // Run simulation
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    if (nodes.length === 0) return;

    const simNodes = nodes.map((n) => ({ ...n }));
    const simLinks = links.map((l) => ({ ...l }));

    const sim = forceSimulation(simNodes)
      .force("link", forceLink<GraphNode, GraphLink>(simLinks).id((d) => d.id).distance(80).strength((l) => (l as GraphLink).weight * 0.5))
      .force("charge", forceManyBody().strength(-120))
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
      .force("collide", forceCollide<GraphNode>().radius((d) => d.r + 6))
      .stop();

    for (let i = 0; i < 300; i++) sim.tick();

    // Clamp positions within padded area
    const posMap = new Map<string, { x: number; y: number }>();
    for (const n of simNodes) {
      posMap.set(n.id, {
        x: Math.max(PAD + n.r, Math.min(WIDTH - PAD - n.r, n.x ?? WIDTH / 2)),
        y: Math.max(PAD + n.r, Math.min(HEIGHT - PAD - n.r, n.y ?? HEIGHT / 2)),
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
        x: Math.max(PAD + r, Math.min(WIDTH - PAD - r, dragStart.current!.nx + dx)),
        y: Math.max(PAD + r, Math.min(HEIGHT - PAD - r, dragStart.current!.ny + dy)),
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
            {/* Clip paths for circular logo masking */}
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

            {/* Nodes: logo clipped to circle + grade-colored ring */}
            {nodes.map((node) => {
              const pos = positions.get(node.id);
              if (!pos) return null;
              const isHovered = hoveredId === node.id;
              const color = gradeColor(node.grade);
              const innerR = node.r - RING_WIDTH;
              const logoUrl = logos?.[node.id];

              return (
                <g
                  key={node.id}
                  style={{ cursor: "pointer" }}
                  onMouseDown={(e) => handleMouseDown(e, node.id)}
                  onMouseEnter={() => setHoveredId(node.id)}
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
                    opacity={isHovered ? 1 : 0.85}
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

            {/* Tooltip */}
            {hoveredId && (() => {
              const node = nodes.find((n) => n.id === hoveredId);
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

            {/* Legend */}
            {[
              { label: "A", color: GRADE_RADAR_COLORS.A },
              { label: "B", color: GRADE_RADAR_COLORS.B },
              { label: "C", color: GRADE_RADAR_COLORS.C },
              { label: "D", color: GRADE_RADAR_COLORS.D },
              { label: "F", color: GRADE_RADAR_COLORS.F },
            ].map(({ label, color }, i) => (
              <g key={label} transform={`translate(${WIDTH - PAD - 80}, ${PAD + i * 18})`}>
                <circle cx={6} cy={6} r={6} fill="var(--color-card, #1a1a2e)" stroke={color} strokeWidth={2.5} />
                <text x={18} y={10} fill="currentColor" fontSize={10} opacity={0.6}>
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
