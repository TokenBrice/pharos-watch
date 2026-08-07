import type { ReactNode } from "react";
import { formatCurrency } from "@shared/lib/format";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { DEPENDENCY_TYPE_PRESENTATION } from "@/components/contagion-graph-model";
import type { ResolvedLink } from "@/components/contagion-graph-graph";

interface TooltipNode {
  id: string;
  symbol: string;
  grade: V9Grade;
  mcap: number;
  r: number;
}

interface TooltipNodeMap {
  get(id: string): TooltipNode | undefined;
}

interface TooltipLinkMap {
  get(index: number): ResolvedLink | undefined;
}

interface PositionMap {
  get(id: string): { x: number; y: number } | undefined;
}

interface TooltipContext {
  activeHoveredId: string | null;
  activeHoveredEdge: number | null;
  nodeMap: TooltipNodeMap;
  positions: PositionMap;
  resolvedLinkByIndex: TooltipLinkMap;
  width: number;
  height: number;
  pad: number;
}

/**
 * Only a weighted collateral share has a percentage worth reading. A wrapper is
 * a full claim by definition, and an unscored edge has no modeled size — a
 * "100%" or "0%" on either would be noise at best and misleading at worst.
 */
function describeLinkMateriality(link: ResolvedLink): string {
  const { label, showWeight } = DEPENDENCY_TYPE_PRESENTATION[link.type];
  return showWeight && link.weight > 0 ? `${label} · ${Math.round(link.weight * 100)}%` : label;
}

export function buildTooltipAnnouncement({
  activeHoveredId,
  activeHoveredEdge,
  nodeMap,
  resolvedLinkByIndex,
}: TooltipContext): string {
  if (activeHoveredEdge !== null) {
    const link = resolvedLinkByIndex.get(activeHoveredEdge);
    if (!link) return "";
    const fromNode = nodeMap.get(link.tgtId);
    const toNode = nodeMap.get(link.srcId);
    if (!fromNode || !toNode) return "";
    return `${fromNode.symbol} to ${toNode.symbol}, ${describeLinkMateriality(link)} dependency`;
  }

  if (activeHoveredId) {
    const node = nodeMap.get(activeHoveredId);
    if (!node) return "";
    return `${node.symbol}, Grade ${node.grade}, market cap ${formatCurrency(node.mcap)}`;
  }

  return "";
}

export function buildNodeTooltipElement({
  activeHoveredId,
  activeHoveredEdge,
  nodeMap,
  positions,
  width,
  pad,
}: TooltipContext): ReactNode {
  if (!activeHoveredId || activeHoveredEdge !== null) return null;
  const node = nodeMap.get(activeHoveredId);
  const position = positions.get(activeHoveredId);
  if (!node || !position) return null;
  const tx = Math.min(position.x + node.r + 8, width - 135);
  const ty = Math.max(pad, position.y - 20);
  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={125} height={52} rx={6}
        fill="var(--color-card, #f8f9fa)" stroke="var(--color-border, #e2e5e9)" strokeWidth={1} />
      <text x={tx + 8} y={ty + 18} fill="currentColor" fontSize={12} fontWeight={600}>
        {node.symbol}
      </text>
      <text x={tx + 8} y={ty + 34} fill="currentColor" fontSize={10} opacity={0.7}>
        Grade: {node.grade}
      </text>
      <text x={tx + 8} y={ty + 46} fill="currentColor" fontSize={10} opacity={0.7} fontFamily="var(--font-mono, monospace)">
        {formatCurrency(node.mcap)}
      </text>
    </g>
  );
}

export function buildEdgeTooltipElement({
  activeHoveredEdge,
  nodeMap,
  positions,
  resolvedLinkByIndex,
  width,
  height,
  pad,
}: TooltipContext): ReactNode {
  if (activeHoveredEdge === null) return null;
  const link = resolvedLinkByIndex.get(activeHoveredEdge);
  if (!link) return null;
  const fromPos = positions.get(link.tgtId);
  const toPos = positions.get(link.srcId);
  const fromNode = nodeMap.get(link.tgtId);
  const toNode = nodeMap.get(link.srcId);
  if (!fromPos || !toPos || !fromNode || !toNode) return null;
  const mx = (fromPos.x + toPos.x) / 2;
  const my = (fromPos.y + toPos.y) / 2;
  const tx = Math.min(Math.max(mx + 8, pad), width - 150);
  const ty = Math.min(Math.max(my - 20, pad), height - 44);
  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={140} height={38} rx={6}
        fill="var(--color-card, #f8f9fa)" stroke="var(--color-border, #e2e5e9)" strokeWidth={1} />
      <text x={tx + 8} y={ty + 15} fill="currentColor" fontSize={11} fontWeight={600}>
        {fromNode.symbol} → {toNode.symbol}
      </text>
      <text x={tx + 8} y={ty + 30} fill="currentColor" fontSize={10} opacity={0.7}>
        {describeLinkMateriality(link)}
      </text>
    </g>
  );
}
