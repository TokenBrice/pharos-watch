"use client";

import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react";
import { gradeColor, TYPE_COLORS, TYPE_DASH } from "@/components/contagion-graph-model";
import type { FocusMode, ResolvedLink } from "@/components/contagion-graph-graph";
import {
  HEIGHT,
  HUB_LABEL_FONT_SIZE,
  PAD,
  RING_WIDTH,
  WIDTH,
  type GraphNode,
  type HubTier,
  type SupernodeState,
} from "@/lib/contagion-layout";
import { formatCurrency } from "@shared/lib/format";

const RIPPLE_HOP_DELAY_MS = 100;

type PositionMap = ReadonlyMap<string, { x: number; y: number }>;

interface ContagionGraphSvgProps {
  svgRef: RefObject<SVGSVGElement | null>;
  nodes: GraphNode[];
  visibleLinks: ResolvedLink[];
  visibleNodeIds: Set<string>;
  positions: PositionMap;
  dragId: string | null;
  focusMode: FocusMode;
  supernodeState: SupernodeState;
  logos?: Record<string, string>;
  activeHoveredId: string | null;
  activeHoveredEdge: number | null;
  focusedId: string | null;
  connectedNodes: Set<string>;
  connectedEdges: Set<number>;
  nodeDistance: Map<string, number>;
  edgeDistance: Map<number, number>;
  nodeTooltipEl: ReactNode;
  edgeTooltipEl: ReactNode;
  onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerUp: () => void;
  onNodePointerDown: (event: PointerEvent, nodeId: string) => void;
  onNodeKeyDown: (event: KeyboardEvent, nodeId: string) => void;
  onNodeMouseEnter: (nodeId: string) => void;
  onNodeMouseLeave: () => void;
  onNodeFocus: (nodeId: string) => void;
  onNodeBlur: () => void;
  onNodeClick: (nodeId: string) => void;
  onEdgeMouseEnter: (edgeIndex: number) => void;
  onEdgeMouseLeave: () => void;
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
  connectedNodes: Set<string>;
  nodeDistance: Map<string, number>;
  tierById: ReadonlyMap<string, HubTier>;
  onPointerDown: (event: PointerEvent, nodeId: string) => void;
  onKeyDown: (event: KeyboardEvent, nodeId: string) => void;
  onMouseEnter: (nodeId: string) => void;
  onMouseLeave: () => void;
  onFocus: (nodeId: string) => void;
  onBlur: () => void;
  onClick: (nodeId: string) => void;
}

function ContagionGraphClipPaths({
  nodes,
  positions,
}: {
  nodes: GraphNode[];
  positions: PositionMap;
}) {
  return (
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
  const swBase = 1 + link.weight * 5;
  const sw = swBase * (isCoreHubEdge ? 1.2 : isHubEdge ? 1.05 : 0.85);
  const soBase = 0.12 + link.weight * (isHubEdge ? 0.52 : 0.34);
  const so = isCoreHubEdge ? Math.min(0.92, soBase + 0.14) : soBase;
  const defaultOpacity = isCoreHubEdge ? so : isHubEdge ? so * 0.82 : so * 0.46;
  const edgeHopDist = edgeDistance.get(link.index);
  const edgeOpacity = isNodeHovered && !isConnected && !isEdgeDirectHovered
    ? 0.05
    : isEdgeDirectHovered
      ? 0.9
      : isConnected
        ? Math.max(0.3, defaultOpacity * (1 - (edgeHopDist ?? 1) * 0.12))
        : defaultOpacity;
  const edgeDelay = isNodeHovered && isConnected && edgeHopDist != null
    ? edgeHopDist * RIPPLE_HOP_DELAY_MS
    : 0;

  return {
    edgeOpacity,
    edgeDelay,
    strokeWidth: isEdgeDirectHovered ? sw + 1 : sw,
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

  const { edgeOpacity, edgeDelay, strokeWidth } = getEdgePresentation({
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
        stroke={TYPE_COLORS[link.type]}
        strokeWidth={strokeWidth}
        opacity={edgeOpacity}
        strokeDasharray={TYPE_DASH[link.type]}
        pointerEvents="none"
        style={{
          transition: `opacity 200ms var(--motion-ease-standard) ${edgeDelay}ms, stroke-width 160ms var(--motion-ease-standard)`,
        }}
      />
    </g>
  );
}

function getNodePresentation({
  node,
  position,
  activeHoveredId,
  connectedNodes,
  nodeDistance,
  tierById,
}: Pick<NodeRenderProps, "node" | "position" | "activeHoveredId" | "connectedNodes" | "nodeDistance" | "tierById">) {
  const isHovered = activeHoveredId === node.id;
  const isNodeDimmed = activeHoveredId !== null && activeHoveredId !== node.id && !connectedNodes.has(node.id);
  const tier = tierById.get(node.id) ?? 0;
  const isHub = tier > 0;
  const isCoreHub = tier === 2;
  const color = gradeColor(node.grade);
  const hubLabelY = Math.max(PAD + 10, Math.min(HEIGHT - PAD - 2, position.y + node.r + (isCoreHub ? 12 : 10)));
  const hopDist = nodeDistance.get(node.id);
  const isInRipple = activeHoveredId !== null && hopDist != null && hopDist > 0;
  const nodeDelay = isInRipple ? hopDist * RIPPLE_HOP_DELAY_MS : 0;
  const nodeOpacity = isNodeDimmed
    ? 0.4
    : isHovered
      ? 1
      : isInRipple
        ? Math.max(0.6, 0.95 - (hopDist - 1) * 0.08)
        : 0.85;

  return { isHovered, isHub, isCoreHub, color, hubLabelY, nodeDelay, nodeOpacity };
}

function ContagionGraphNode({
  node,
  position,
  focusMode,
  logos,
  activeHoveredId,
  focusedId,
  connectedNodes,
  nodeDistance,
  tierById,
  onPointerDown,
  onKeyDown,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  onClick,
}: NodeRenderProps) {
  const logoUrl = logos?.[node.id];
  const innerR = node.r - RING_WIDTH;
  const { isHovered, isHub, isCoreHub, color, hubLabelY, nodeDelay, nodeOpacity } = getNodePresentation({
    node,
    position,
    activeHoveredId,
    connectedNodes,
    nodeDistance,
    tierById,
  });

  return (
    <g
      key={node.id}
      tabIndex={0}
      data-node-id={node.id}
      role="button"
      aria-label={`${node.symbol} — Grade ${node.grade}, market cap ${formatCurrency(node.mcap)}`}
      style={{ cursor: focusMode === "neighborhood" ? "pointer" : "grab" }}
      onPointerDown={(event) => onPointerDown(event, node.id)}
      onMouseEnter={() => onMouseEnter(node.id)}
      onMouseLeave={onMouseLeave}
      onFocus={() => onFocus(node.id)}
      onBlur={onBlur}
      onKeyDown={(event) => onKeyDown(event, node.id)}
      onClick={() => onClick(node.id)}
    >
      <circle
        cx={position.x}
        cy={position.y}
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
          cx={position.x}
          cy={position.y}
          r={node.r + 2.5}
          fill="none"
          stroke={color}
          strokeWidth={1.4}
          opacity={0.55}
        />
      )}

      {logoUrl ? (
        <image
          href={logoUrl}
          x={position.x - innerR}
          y={position.y - innerR}
          width={innerR * 2}
          height={innerR * 2}
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
            fontSize={Math.min(10, node.r * 0.65)}
            fontWeight={600}
            pointerEvents="none"
          >
            {node.symbol.length > 5 ? node.symbol.slice(0, 4) : node.symbol}
          </text>
        )
      )}

      {(isHovered || focusedId === node.id) && (
        <circle
          cx={position.x}
          cy={position.y}
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
          x={position.x}
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
}

export function ContagionGraphSvg({
  svgRef,
  nodes,
  visibleLinks,
  visibleNodeIds,
  positions,
  dragId,
  focusMode,
  supernodeState,
  logos,
  activeHoveredId,
  activeHoveredEdge,
  focusedId,
  connectedNodes,
  connectedEdges,
  nodeDistance,
  edgeDistance,
  nodeTooltipEl,
  edgeTooltipEl,
  onPointerMove,
  onPointerUp,
  onNodePointerDown,
  onNodeKeyDown,
  onNodeMouseEnter,
  onNodeMouseLeave,
  onNodeFocus,
  onNodeBlur,
  onNodeClick,
  onEdgeMouseEnter,
  onEdgeMouseLeave,
}: ContagionGraphSvgProps) {
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full"
      style={{ cursor: dragId ? "grabbing" : "default" }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <ContagionGraphClipPaths nodes={nodes} positions={positions} />

      {visibleLinks.map((link) => (
        <ContagionGraphEdge
          key={`${link.srcId}-${link.tgtId}-${link.index}`}
          link={link}
          positions={positions}
          activeHoveredId={activeHoveredId}
          activeHoveredEdge={activeHoveredEdge}
          connectedEdges={connectedEdges}
          edgeDistance={edgeDistance}
          onMouseEnter={onEdgeMouseEnter}
          onMouseLeave={onEdgeMouseLeave}
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
            connectedNodes={connectedNodes}
            nodeDistance={nodeDistance}
            tierById={supernodeState.tierById}
            onPointerDown={onNodePointerDown}
            onKeyDown={onNodeKeyDown}
            onMouseEnter={onNodeMouseEnter}
            onMouseLeave={onNodeMouseLeave}
            onFocus={onNodeFocus}
            onBlur={onNodeBlur}
            onClick={onNodeClick}
          />
        );
      })}

      {nodeTooltipEl}
      {edgeTooltipEl}
    </svg>
  );
}
