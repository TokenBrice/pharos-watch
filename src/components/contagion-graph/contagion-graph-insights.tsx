"use client";

import { StablecoinLogo } from "@/components/stablecoin-logo";
import type { ResolvedLink } from "@/components/contagion-graph-graph";
import type { GraphNode } from "@/lib/contagion-layout";
import { formatCurrency } from "@shared/lib/format";

interface ContagionGraphHubSummary {
  id: string;
  label: string;
  symbol: string;
  dependentCount: number;
  summedDirectDependencyWeight: number;
  uniqueDependentMcapUsd: number;
}

interface ContagionGraphInsightsProps {
  inspectedNode: GraphNode | null;
  visibleLinks: readonly ResolvedLink[];
  nodeMap: ReadonlyMap<string, GraphNode>;
  hubs?: readonly ContagionGraphHubSummary[];
  logos?: Record<string, string>;
  onTraceNode: (nodeId: string) => void;
}

interface NodeLinkSummary {
  count: number;
  weight: number;
  examples: string[];
}

function formatWeight(value: number): string {
  return value.toFixed(2);
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
    weight: matchingLinks.reduce((sum, link) => sum + link.weight, 0),
    examples,
  };
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/45 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}

export function ContagionGraphInsights({
  inspectedNode,
  visibleLinks,
  nodeMap,
  hubs,
  logos,
  onTraceNode,
}: ContagionGraphInsightsProps) {
  const topHubs = (hubs ?? []).slice(0, 4);
  const dependentSummary = inspectedNode
    ? summarizeNodeLinks({
        nodeId: inspectedNode.id,
        visibleLinks,
        nodeMap,
        direction: "dependents",
      })
    : null;
  const upstreamSummary = inspectedNode
    ? summarizeNodeLinks({
        nodeId: inspectedNode.id,
        visibleLinks,
        nodeMap,
        direction: "upstream",
      })
    : null;

  return (
    <aside className="grid content-start gap-3 xl:min-w-0">
      <section className="rounded-lg border border-border/70 bg-card/70 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="pharos-kicker">Selection</p>
            <p className="mt-1 text-sm text-muted-foreground">Hover, focus, or click a node to inspect exposure.</p>
          </div>
          {inspectedNode && (
            <span className="rounded-full border border-border/60 bg-background/60 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
              Grade {inspectedNode.grade}
            </span>
          )}
        </div>

        {inspectedNode ? (
          <div className="mt-4 space-y-4">
            <div className="flex min-w-0 items-center gap-3">
              <StablecoinLogo src={logos?.[inspectedNode.id]} name={inspectedNode.symbol} size={36} />
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-foreground">{inspectedNode.symbol}</p>
                <p className="font-mono text-xs tabular-nums text-muted-foreground">
                  {formatCurrency(inspectedNode.mcap, 1)} market cap
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <MiniMetric label="Direct dependents" value={String(dependentSummary?.count ?? 0)} />
              <MiniMetric label="Upstream links" value={String(upstreamSummary?.count ?? 0)} />
              <MiniMetric label="Dependent weight" value={formatWeight(dependentSummary?.weight ?? 0)} />
              <MiniMetric label="Upstream weight" value={formatWeight(upstreamSummary?.weight ?? 0)} />
            </div>

            <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>
                Supports{" "}
                <span className="font-medium text-foreground">
                  {dependentSummary?.examples.length ? dependentSummary.examples.join(", ") : "no visible dependents"}
                </span>
              </p>
              <p>
                Depends on{" "}
                <span className="font-medium text-foreground">
                  {upstreamSummary?.examples.length ? upstreamSummary.examples.join(", ") : "no visible upstream nodes"}
                </span>
              </p>
            </div>

            <button
              type="button"
              className="pharos-focus-ring inline-flex h-9 w-full items-center justify-center rounded-md border border-border/70 bg-background/70 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
              onClick={() => onTraceNode(inspectedNode.id)}
            >
              Trace selected neighborhood
            </button>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No visible node is available for inspection.</p>
        )}
      </section>

      {topHubs.length > 0 && (
        <section className="rounded-lg border border-border/70 bg-card/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="pharos-kicker">Systemic Hubs</p>
              <h3 className="mt-1 text-sm font-semibold tracking-tight">Largest direct blast radius</h3>
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">Top {topHubs.length}</span>
          </div>

          <div className="mt-3 divide-y divide-border/50">
            {topHubs.map((hub, index) => (
              <button
                key={hub.id}
                type="button"
                className="pharos-focus-ring group flex w-full items-center gap-3 rounded-sm px-1 py-2 text-left transition-colors hover:bg-muted/25"
                onClick={() => onTraceNode(hub.id)}
              >
                <span className="font-mono text-[10px] text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground group-hover:text-frost-blue">
                    {hub.symbol}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {hub.dependentCount} dependents · {formatWeight(hub.summedDirectDependencyWeight)} weight
                  </span>
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatCurrency(hub.uniqueDependentMcapUsd, 1)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
