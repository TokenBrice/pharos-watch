"use client";

import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent, ReactNode } from "react";
import { gradeColor, TYPE_COLORS, TYPE_DASH } from "@/components/contagion-graph-model";
import type { FocusMode, ResolvedLink } from "@/components/contagion-graph-graph";
import {
  GRAPH_DIM_EDGE_OPACITY,
  GRAPH_DIM_NODE_OPACITY,
  GRAPH_EDGE_HOVER_OPACITY,
  GRAPH_EDGE_HOVER_STROKE_WIDTH,
  GRAPH_RIPPLE_HOP_4_EDGE_OPACITY,
  GRAPH_RIPPLE_HOP_4_OPACITY,
  GRAPH_RIPPLE_HOP_DELAY_MS,
} from "@/components/contagion-graph/contagion-graph-tokens";
import {
  HEIGHT,
  HUB_LABEL_FONT_SIZE,
  PAD,
  RING_WIDTH,
  WIDTH,
  type GraphNode,
  type HubTier,
} from "@/lib/contagion-layout";
import { formatCurrency } from "@shared/lib/format";
import type { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";

type PositionMap = ReadonlyMap<string, { x: number; y: number }>;
type ContagionGraphModel = ReturnType<typeof useContagionGraphModel>;

const MIN_EDGE_DISPLAY_WEIGHT = 0.12;

/**
 * Raster token logos in `public/logos` are 50px sources, so a node scaled up for a
 * sparse detail neighborhood would upscale them into visible pixelation. Cap the
 * drawn image at this viewBox radius and let the grade-tinted disc carry the rest
 * of the node. Vector logos are exempt — they scale cleanly.
 */
const MAX_RASTER_LOGO_RADIUS = 46;

function resolveLogoRadius(logoUrl: string | undefined, innerR: number, logoZoom: number): number {
  const requested = innerR * logoZoom;
  if (!logoUrl || logoUrl.endsWith(".svg")) return requested;
  return Math.min(requested, MAX_RASTER_LOGO_RADIUS);
}

interface ContagionGraphSvgProps {
  graph: ContagionGraphModel;
  logos?: Record<string, string>;
  logoZoom?: number;
  nodeScale?: number;
  suppressHubLabels?: boolean;
  showTickerLabels?: boolean;
  fillHeight?: boolean;
  nodeTooltipEl: ReactNode;
  edgeTooltipEl: ReactNode;
}

interface EdgeRenderProps {
  link: ResolvedLink;
  positions: PositionMap;
  activeHoveredId: string | null;
  activeHoveredEdge: number | null;
  connectedEdges: Set<number>;
  edgeDistance: Map<number, number>;
  onMouseEnter: (edgeIndex: number) => void;
  onMouseLeave: () => void;
}

interface NodeRenderProps {
  node: GraphNode;
  position: { x: number; y: number };
  focusMode: FocusMode;
  logos?: Record<string, string>;
  activeHoveredId: string | null;
  focusedId: string | null;
  pinnedSelectionId: string | null;
  isPinnedPosition: boolean;
  connectedNodes: Set<string>;
  nodeDistance: Map<string, number>;
  tierById: ReadonlyMap<string, HubTier>;
  logoZoom: number;
  nodeScale: number;
  suppressHubLabels: boolean;
  showTickerLabels: boolean;
  onPointerDown: (event: PointerEvent<SVGGElement>, nodeId: string) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, nodeId: string) => void;
  onMouseEnter: (nodeId: string) => void;
  onMouseLeave: () => void;
  onFocus: (nodeId: string) => void;
  onBlur: () => void;
  onClick: (nodeId: string) => void;
  onDoubleClick: (nodeId: string) => void;
}

function ContagionGraphClipPaths({
  nodes,
  positions,
  nodeScale,
}: {
  nodes: GraphNode[];
  positions: PositionMap;
  nodeScale: number;
}) {
  return (
    <defs>
      {nodes.map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const innerR = Math.max(node.r * nodeScale - RING_WIDTH, 3);
        return (
          <clipPath key={node.id} id={`clip-n-${node.id}`}>
            <circle cx={pos.x} cy={pos.y} r={innerR} />
          </clipPath>
        );
      })}
    </defs>
  );
}

function getEdgePresentation({
  link,
  activeHoveredId,
  activeHoveredEdge,
  connectedEdges,
  edgeDistance,
}: Pick<EdgeRenderProps, "link" | "activeHoveredId" | "activeHoveredEdge" | "connectedEdges" | "edgeDistance">) {
  const isEdgeDirectHovered = activeHoveredEdge === link.index;
  const isConnected = connectedEdges.has(link.index);
  const isNodeHovered = activeHoveredId !== null;
  const isHubEdge = link.srcTier > 0 || link.tgtTier > 0;
  const isCoreHubEdge = link.srcTier === 2 || link.tgtTier === 2;
  // Bounded-unknown basket edges carry a modeled weight of 0. Stroke geometry
  // floors at MIN_EDGE_DISPLAY_WEIGHT so an unsized relationship still reads as
  // a drawn edge; its dashed stroke is what marks the magnitude as unknown.
  const displayWeight = Math.max(link.weight, MIN_EDGE_DISPLAY_WEIGHT);
  const swBase = 1 + displayWeight * 5;
  const sw = swBase * (isCoreHubEdge ? 1.2 : isHubEdge ? 1.05 : 0.85);
  const soBase = 0.12 + displayWeight * (isHubEdge ? 0.52 : 0.34);
  const so = isCoreHubEdge ? Math.min(0.92, soBase + 0.14) : soBase;
  const defaultOpacity = isCoreHubEdge ? so : isHubEdge ? so * 0.82 : so * 0.46;
  const edgeHopDist = edgeDistance.get(link.index);
  const isHop4 = edgeHopDist === 4;
  const connectedRippleOpacity = isHop4
    ? GRAPH_RIPPLE_HOP_4_EDGE_OPACITY
    : Math.max(0.3, defaultOpacity * (1 - (edgeHopDist ?? 1) * 0.12));
  const edgeOpacity = isNodeHovered && !isConnected && !isEdgeDirectHovered
    ? GRAPH_DIM_EDGE_OPACITY
    : isEdgeDirectHovered
      ? GRAPH_EDGE_HOVER_OPACITY
      : isConnected
        ? connectedRippleOpacity
        : defaultOpacity;
  const edgeDelay = isNodeHovered && isConnected && edgeHopDist != null
    ? edgeHopDist * GRAPH_RIPPLE_HOP_DELAY_MS
    : 0;
  const useHoverStroke = isEdgeDirectHovered || (isNodeHovered && isConnected && !isHop4);
  const strokeWidth = useHoverStroke ? GRAPH_EDGE_HOVER_STROKE_WIDTH : sw;
  const strokeColor = useHoverStroke ? "var(--p-frost-blue)" : TYPE_COLORS[link.type];

  return {
    edgeOpacity,
    edgeDelay,
    strokeWidth,
    strokeColor,
  };
}

function ContagionGraphEdge({
  link,
  positions,
  activeHoveredId,
  activeHoveredEdge,
  connectedEdges,
  edgeDistance,
  onMouseEnter,
  onMouseLeave,
}: EdgeRenderProps) {
  const posA = positions.get(link.srcId);
  const posB = positions.get(link.tgtId);
  if (!posA || !posB) return null;

  const { edgeOpacity, edgeDelay, strokeWidth, strokeColor } = getEdgePresentation({
    link,
    activeHoveredId,
    activeHoveredEdge,
    connectedEdges,
    edgeDistance,
  });

  return (
    <g key={`${link.srcId}-${link.tgtId}-${link.index}`}>
      <line
        x1={posA.x} y1={posA.y} x2={posB.x} y2={posB.y}
        stroke="transparent" strokeWidth={14}
        style={{ cursor: "pointer" }}
        onMouseEnter={() => onMouseEnter(link.index)}
        onMouseLeave={onMouseLeave}
      />
      <line
        x1={posA.x} y1={posA.y} x2={posB.x} y2={posB.y}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        opacity={edgeOpacity}
        strokeDasharray={TYPE_DASH[link.type]}
        pointerEvents="none"
        style={{
          transition: `opacity 200ms var(--motion-ease-standard) ${edgeDelay}ms, stroke-width 160ms var(--motion-ease-standard), stroke 200ms var(--motion-ease-standard)`,
        }}
      />
    </g>
  );
}

function getNodePresentation({
  node,
  activeHoveredId,
  connectedNodes,
  nodeDistance,
  tierById,
}: Pick<NodeRenderProps, "node" | "activeHoveredId" | "connectedNodes" | "nodeDistance" | "tierById">) {
  const isHovered = activeHoveredId === node.id;
  const isNodeDimmed = activeHoveredId !== null && activeHoveredId !== node.id && !connectedNodes.has(node.id);
  const tier = tierById.get(node.id) ?? 0;
  const isHub = tier > 0;
  const isCoreHub = tier === 2;
  const color = gradeColor(node.grade);
  const hopDist = nodeDistance.get(node.id);
  const isInRipple = activeHoveredId !== null && hopDist != null && hopDist > 0;
  const nodeDelay = isInRipple && hopDist != null ? hopDist * GRAPH_RIPPLE_HOP_DELAY_MS : 0;
  const isHop4 = hopDist === 4;
  const rippleOpacity = isHop4
    ? GRAPH_RIPPLE_HOP_4_OPACITY
    : Math.max(0.6, 0.95 - ((hopDist ?? 1) - 1) * 0.08);
  const nodeOpacity = isNodeDimmed
    ? GRAPH_DIM_NODE_OPACITY
    : isHovered
      ? 1
      : isInRipple
        ? rippleOpacity
        : 0.85;

  return { isHovered, isHub, isCoreHub, color, nodeDelay, nodeOpacity };
}

function ContagionGraphNode({
  node,
  position,
  focusMode,
  logos,
  activeHoveredId,
  focusedId,
  pinnedSelectionId,
  isPinnedPosition,
  connectedNodes,
  nodeDistance,
  tierById,
  logoZoom,
  nodeScale,
  suppressHubLabels,
  showTickerLabels,
  onPointerDown,
  onKeyDown,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  onClick,
  onDoubleClick,
}: NodeRenderProps) {
  const logoUrl = logos?.[node.id];
  const visualR = node.r * nodeScale;
  const innerR = Math.max(visualR - RING_WIDTH, 3);
  const { isHovered, isHub, isCoreHub, color, nodeDelay, nodeOpacity } = getNodePresentation({
    node,
    activeHoveredId,
    connectedNodes,
    nodeDistance,
    tierById,
  });

  const nodeCursor = isPinnedPosition ? "default" : focusMode === "neighborhood" ? "pointer" : "grab";
  const logoR = resolveLogoRadius(logoUrl, innerR, logoZoom);
  const shouldRenderLabel = showTickerLabels || (!suppressHubLabels && isHub);
  const tickerFontSize = HUB_LABEL_FONT_SIZE * nodeScale;
  const labelGap = showTickerLabels ? tickerFontSize * 0.7 : isCoreHub ? 12 : 10;
  const labelY = Math.max(PAD + 10, Math.min(HEIGHT - PAD - 2, position.y + visualR + labelGap));
  const labelText = showTickerLabels ? node.symbol : `${node.symbol} · ${node.grade}`;
  return (
    <g
      key={node.id}
      tabIndex={0}
      data-node-id={node.id}
      data-pinned={isPinnedPosition ? "true" : undefined}
      role="button"
      aria-label={`${node.symbol} — Grade ${node.grade}, market cap ${formatCurrency(node.mcap)}${isPinnedPosition ? " (pinned)" : ""}`}
      style={{ cursor: nodeCursor }}
      onPointerDown={(event) => onPointerDown(event, node.id)}
      onMouseEnter={() => onMouseEnter(node.id)}
      onMouseLeave={onMouseLeave}
      onFocus={() => onFocus(node.id)}
      onBlur={onBlur}
      onKeyDown={(event) => onKeyDown(event, node.id)}
      onClick={() => onClick(node.id)}
      onDoubleClick={() => onDoubleClick(node.id)}
    >
      <circle
        cx={position.x}
        cy={position.y}
        r={visualR}
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
          cx={position.x}
          cy={position.y}
          r={visualR + 2.5 * nodeScale}
          fill="none"
          stroke={color}
          strokeWidth={1.4}
          opacity={0.55}
        />
      )}

      {isPinnedPosition && (
        <circle
          cx={position.x}
          cy={position.y}
          r={Math.max(visualR - RING_WIDTH - 2, 3)}
          fill="none"
          stroke="var(--p-frost-blue)"
          strokeWidth={0.9}
          strokeDasharray="2 2"
          opacity={0.75}
          pointerEvents="none"
        />
      )}

      {logoUrl ? (
        <image
          href={logoUrl}
          x={position.x - logoR}
          y={position.y - logoR}
          width={logoR * 2}
          height={logoR * 2}
          clipPath={`url(#clip-n-${node.id})`}
          preserveAspectRatio="xMidYMid slice"
          pointerEvents="none"
        />
      ) : (
        (node.r >= 12 && (isHovered || isHub)) && (
          <text
            x={position.x}
            y={position.y + 1}
            textAnchor="middle"
            dominantBaseline="central"
            fill="currentColor"
            fontSize={Math.max(10, Math.min(11, node.r * 0.65))}
            fontWeight={600}
            pointerEvents="none"
          >
            {node.symbol.length > 5 ? node.symbol.slice(0, 4) : node.symbol}
          </text>
        )
      )}

      {(isHovered || focusedId === node.id || pinnedSelectionId === node.id) && (
        <circle
          cx={position.x}
          cy={position.y}
          r={visualR + (focusedId === node.id ? 3 : 2) * nodeScale}
          fill="none"
          stroke={
            focusedId === node.id
              ? "var(--color-ring)"
              : pinnedSelectionId === node.id && !isHovered
                ? "var(--p-frost-blue)"
                : "currentColor"
          }
          strokeWidth={focusedId === node.id ? 2 : 1.5}
          strokeDasharray={focusedId === node.id ? "4 2" : undefined}
          opacity={focusedId === node.id ? 0.6 : pinnedSelectionId === node.id && !isHovered ? 0.85 : 0.6}
        />
      )}

      {shouldRenderLabel && (
        <text
          x={position.x}
          y={labelY}
          textAnchor="middle"
          fill="currentColor"
          fontSize={showTickerLabels ? tickerFontSize : isCoreHub ? HUB_LABEL_FONT_SIZE : HUB_LABEL_FONT_SIZE - 1}
          fontWeight={isCoreHub ? 700 : 600}
          stroke="var(--color-card, #f8f9fa)"
          strokeWidth={2.4}
          paintOrder="stroke"
          pointerEvents="none"
        >
          {labelText}
        </text>
      )}
    </g>
  );
}

export function ContagionGraphSvg({
  graph,
  logos,
  logoZoom = 1,
  nodeScale = 1,
  suppressHubLabels = false,
  showTickerLabels = false,
  fillHeight = false,
  nodeTooltipEl,
  edgeTooltipEl,
}: ContagionGraphSvgProps) {
  const {
    nodes,
    visibleLinks,
    visibleNodeIds,
    positions,
    dragId,
    focusMode,
    supernodeState,
    activeHoveredId,
    activeHoveredEdge,
    focusedId,
    pinnedSelectionId,
    pinnedNodeIds,
    connectedNodes,
    connectedEdges,
    nodeDistance,
    edgeDistance,
  } = graph;
  const handleSvgClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (event.target === event.currentTarget) graph.handleClearSelection();
  };
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={fillHeight ? "w-full lg:h-full" : "w-full"}
      style={{ cursor: dragId ? "grabbing" : "default" }}
      onPointerMove={graph.handlePointerMove}
      onPointerUp={graph.handlePointerUp}
      onPointerLeave={graph.handlePointerUp}
      onClick={handleSvgClick}
    >
      <ContagionGraphClipPaths nodes={nodes} positions={positions} nodeScale={nodeScale} />

      {visibleLinks.map((link) => (
        <ContagionGraphEdge
          key={`${link.srcId}-${link.tgtId}-${link.index}`}
          link={link}
          positions={positions}
          activeHoveredId={activeHoveredId}
          activeHoveredEdge={activeHoveredEdge}
          connectedEdges={connectedEdges}
          edgeDistance={edgeDistance}
          onMouseEnter={graph.handleEdgeMouseEnter}
          onMouseLeave={graph.handleEdgeMouseLeave}
        />
      ))}

      {nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => {
        const position = positions.get(node.id);
        if (!position) return null;
        return (
          <ContagionGraphNode
            key={node.id}
            node={node}
            position={position}
            focusMode={focusMode}
            logos={logos}
            activeHoveredId={activeHoveredId}
            focusedId={focusedId}
            pinnedSelectionId={pinnedSelectionId}
            isPinnedPosition={pinnedNodeIds.has(node.id)}
            connectedNodes={connectedNodes}
            nodeDistance={nodeDistance}
            tierById={supernodeState.tierById}
            logoZoom={logoZoom}
            nodeScale={nodeScale}
            suppressHubLabels={suppressHubLabels}
            showTickerLabels={showTickerLabels}
            onPointerDown={graph.handlePointerDown}
            onKeyDown={graph.handleNodeKeyDown}
            onMouseEnter={graph.handleNodeMouseEnter}
            onMouseLeave={graph.handleNodeMouseLeave}
            onFocus={graph.handleNodeFocus}
            onBlur={graph.handleNodeBlur}
            onClick={graph.handleNodeClick}
            onDoubleClick={graph.handleNodeDoubleClick}
          />
        );
      })}

      {nodeTooltipEl}
      {edgeTooltipEl}
    </svg>
  );
}
