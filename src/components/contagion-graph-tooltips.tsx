import type { ReactNode } from "react";
import { formatCurrency } from "@shared/lib/format";
import type { V9Grade } from "@shared/types/safety-score-v9";
import { DEPENDENCY_TYPE_PRESENTATION, graphNodeLabel } from "@/components/contagion-graph-model";
import type { ResolvedLink } from "@/components/contagion-graph-graph";
import type { ContagionGraphCard } from "@/lib/contagion-layout";

interface TooltipNode {
  id: string;
  symbol: string;
  grade: V9Grade | null;
  partialEvidence?: ContagionGraphCard["partialEvidence"];
  mcap: number | null;
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
 * Only a known weighted collateral share has a percentage worth reading.
 * A wrapper is a full claim by definition. Score availability is independent
 * of share availability and is disclosed without hiding a known share.
 */
function describeLinkMateriality(link: ResolvedLink): string {
  const { label, showWeight } = DEPENDENCY_TYPE_PRESENTATION[link.type];
  const materiality = !showWeight || link.shareUnknown || link.weight <= 0
    ? label
    : `${label} · ${link.weight < 0.01 ? "<1%" : `${Math.round(link.weight * 100)}%`}`;
  return link.scoreKnown === false ? `${materiality} · upstream score unavailable` : materiality;
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
    return `${graphNodeLabel(toNode)} depends on ${graphNodeLabel(fromNode)}, ${describeLinkMateriality(link)} dependency`;
  }

  if (activeHoveredId) {
    const node = nodeMap.get(activeHoveredId);
    if (!node) return "";
    return `${graphNodeLabel(node)}, ${node.grade === null ? "Pipeline gap" : `Grade ${node.grade}`}${node.partialEvidence ? `, Partial evidence: pipeline gap (${node.partialEvidence.causes.join("/")})` : ""}, ${node.mcap === null ? "mcap n/a" : `market cap ${formatCurrency(node.mcap)}`}`;
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
  const label = graphNodeLabel(node);
  const tooltipWidth = Math.max(node.partialEvidence ? 280 : 125, label.length * 7 + 16);
  const tx = Math.min(position.x + node.r + 8, width - tooltipWidth - pad);
  const ty = Math.max(pad, position.y - 20);
  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={tooltipWidth} height={node.partialEvidence ? 68 : 52} rx={6}
        fill="var(--color-card, #f8f9fa)" stroke="var(--color-border, #e2e5e9)" strokeWidth={1} />
      <text x={tx + 8} y={ty + 18} fill="currentColor" fontSize={12} fontWeight={600}>
        {label}
      </text>
      <text x={tx + 8} y={ty + 34} fill="currentColor" fontSize={10} opacity={0.7}>
        {node.grade === null ? "Pipeline gap" : `Grade: ${node.grade}`}
      </text>
      <text x={tx + 8} y={ty + 46} fill="currentColor" fontSize={10} opacity={0.7} fontFamily="var(--font-mono, monospace)">
        {node.mcap === null ? "mcap n/a" : formatCurrency(node.mcap)}
      </text>
      {node.partialEvidence ? (
        <text x={tx + 8} y={ty + 60} fill="currentColor" fontSize={10}>
          Partial evidence: pipeline gap ({node.partialEvidence.causes.join("/")})
        </text>
      ) : null}
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
  const label = `${graphNodeLabel(toNode)} depends on ${graphNodeLabel(fromNode)}`;
  const tooltipWidth = Math.max(link.scoreKnown === false ? 250 : 180, label.length * 6.5 + 16);
  const tx = Math.min(Math.max(mx + 8, pad), width - tooltipWidth - pad);
  const ty = Math.min(Math.max(my - 20, pad), height - 44);
  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={tooltipWidth} height={38} rx={6}
        fill="var(--color-card, #f8f9fa)" stroke="var(--color-border, #e2e5e9)" strokeWidth={1} />
      <text x={tx + 8} y={ty + 15} fill="currentColor" fontSize={11} fontWeight={600}>
        {label}
      </text>
      <text x={tx + 8} y={ty + 30} fill="currentColor" fontSize={10} opacity={0.7}>
        {describeLinkMateriality(link)}
      </text>
    </g>
  );
}
