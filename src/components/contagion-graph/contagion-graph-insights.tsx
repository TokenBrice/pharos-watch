"use client";

import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { ResolvedLink } from "@/components/contagion-graph-graph";
import type { GraphNode } from "@/lib/contagion-layout";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@shared/lib/format";
import type { HubExposure } from "@shared/lib/dependency-exposure";

interface ContagionGraphInsightsProps {
  inspectedNode: GraphNode | null;
  visibleLinks: readonly ResolvedLink[];
  fullLinks: readonly ResolvedLink[];
  directExposureById: ReadonlyMap<string, HubExposure>;
  nodeMap: ReadonlyMap<string, GraphNode>;
  logos?: Record<string, string>;
  onTraceNode: (nodeId: string) => void;
  onUseAsExposureRoot?: (coinId: string) => void;
  variant?: "overlay" | "panel";
}

interface NodeLinkSummary {
  count: number;
  examples: string[];
}

function summarizeNodeLinks({
  nodeId,
  visibleLinks,
  nodeMap,
  direction,
}: {
  nodeId: string;
  visibleLinks: readonly ResolvedLink[];
  nodeMap: ReadonlyMap<string, GraphNode>;
  direction: "dependents" | "upstream";
}): NodeLinkSummary {
  const matchingLinks = visibleLinks.filter((link) =>
    direction === "dependents" ? link.tgtId === nodeId : link.srcId === nodeId,
  );
  const seenNodeIds = new Set<string>();
  const examples: string[] = [];

  for (const link of [...matchingLinks].sort((a, b) => b.weight - a.weight)) {
    const relatedId = direction === "dependents" ? link.srcId : link.tgtId;
    if (seenNodeIds.has(relatedId)) continue;
    seenNodeIds.add(relatedId);
    const relatedNode = nodeMap.get(relatedId);
    if (relatedNode && examples.length < 3) examples.push(relatedNode.symbol);
  }

  return {
    count: seenNodeIds.size,
    examples,
  };
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-sm border px-2 py-1.5"
      style={{ backgroundColor: "var(--graph-panel-bg)", borderColor: "var(--graph-grid-line)" }}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

export function ContagionGraphInsights({
  inspectedNode,
  visibleLinks,
  fullLinks,
  directExposureById,
  nodeMap,
  logos,
  onTraceNode,
  onUseAsExposureRoot,
  variant = "overlay",
}: ContagionGraphInsightsProps) {
  if (!inspectedNode) return null;

  const dependentSummary = summarizeNodeLinks({
    nodeId: inspectedNode.id,
    visibleLinks,
    nodeMap,
    direction: "dependents",
  });
  const upstreamSummary = summarizeNodeLinks({
    nodeId: inspectedNode.id,
    visibleLinks,
    nodeMap,
    direction: "upstream",
  });
  const dependentCount = new Set(fullLinks.filter(link => link.tgtId === inspectedNode.id).map(link => link.srcId)).size;
  const upstreamCount = new Set(fullLinks.filter(link => link.srcId === inspectedNode.id).map(link => link.tgtId)).size;
  const exposure = directExposureById.get(inspectedNode.id)?.direct;

  return (
    <aside
      className={cn(
        "pointer-events-auto rounded-sm border backdrop-blur-sm",
        variant === "overlay"
          ? "absolute right-2 top-2 z-10 hidden w-[280px] max-w-[calc(100%-1rem)] sm:block"
          : "block w-full sm:hidden",
      )}
      style={{ backgroundColor: "var(--graph-panel-bg)", borderColor: "var(--graph-grid-line)" }}
      role="region"
      aria-label="Selected node details"
    >
      <div className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Selection</p>
          <span
            className="rounded-sm border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            style={{ borderColor: "var(--graph-grid-line)" }}
          >
            Grade {inspectedNode.grade}
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <StablecoinLogo src={logos?.[inspectedNode.id]} name={inspectedNode.symbol} size={28} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{inspectedNode.symbol}</p>
            <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {inspectedNode.mcap === null ? "mcap n/a" : formatCurrency(inspectedNode.mcap, 1)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <MiniMetric label="Dependents" value={`${dependentCount} (${dependentSummary.count} visible)`} />
          <MiniMetric label="Upstream" value={`${upstreamCount} (${upstreamSummary.count} visible)`} />
          <MiniMetric label="Direct dependent exposure" value={`${formatCurrency(exposure?.knownUsd ?? 0, 1)}${exposure && !exposure.complete ? " known" : ""}`} />
        </div>
        {exposure && !exposure.complete && (
          <p className="text-[11px] text-muted-foreground">
            {exposure.excludedSupplyUnknownIds.length} supply unavailable; {exposure.unknownShareEdgeCount} shares unavailable.
            {exposure.integrityFlag && " Published shares need review."}
          </p>
        )}

        <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
          <p>
            Supports{" "}
            <span className="font-medium text-foreground">
              {dependentSummary.examples.length ? dependentSummary.examples.join(", ") : "no visible dependents"}
            </span>
          </p>
          <p>
            Depends on{" "}
            <span className="font-medium text-foreground">
              {upstreamSummary.examples.length ? upstreamSummary.examples.join(", ") : "no visible upstream nodes"}
            </span>
          </p>
        </div>

        <button
          type="button"
          className="pharos-focus-ring inline-flex min-h-11 w-full items-center justify-center rounded-sm border font-mono text-[10px] uppercase tracking-[0.14em] text-foreground transition-colors hover:bg-muted/40"
          style={{ borderColor: "var(--graph-grid-line)" }}
          onClick={() => onTraceNode(inspectedNode.id)}
        >
          Trace neighborhood
        </button>
        {onUseAsExposureRoot && (
          <button type="button" data-use-exposure-root className="pharos-focus-ring inline-flex min-h-11 w-full items-center justify-center rounded-sm border text-xs" onClick={() => onUseAsExposureRoot(inspectedNode.id)}>
            Use as exposure root
          </button>
        )}
      </div>
    </aside>
  );
}
