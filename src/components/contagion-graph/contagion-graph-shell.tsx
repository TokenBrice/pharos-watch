"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { ContagionGraphHeader } from "@/components/contagion-graph/contagion-graph-header";
import { ContagionGraphControls } from "@/components/contagion-graph/contagion-graph-controls";
import type { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { graphNodeLabel } from "@/components/contagion-graph-model";
import { trackEvent } from "@/lib/analytics";

interface ContagionGraphShellProps {
  graph: ReturnType<typeof useContagionGraphModel>;
  stage: ReactNode;
  modeControls?: ReactNode;
}

export function ContagionGraphShell({ graph, stage, modeControls }: ContagionGraphShellProps) {
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const [tab, setTab] = useState<"graph" | "list">("graph");
  const openerRef = useRef<HTMLButtonElement>(null);
  const closingForRoot = useRef(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(min-width: 640px)");
    const closeOnDesktop = () => { if (media.matches) setIsFullscreenOpen(false); };
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);
  const root = graph.pinnedSelectionId ?? graph.effectiveSelectedNeighborhoodId;
  const neighborhood = new Set<string>(root ? [root] : []);
  for (const link of graph.fullResolvedLinks) {
    if (link.srcId === root) neighborhood.add(link.tgtId);
    if (link.tgtId === root) neighborhood.add(link.srcId);
  }
  const list = (
    <div className="space-y-2 p-3">
      <label className="block text-xs">
        Choose neighborhood
        <select className="pharos-focus-ring mt-1 min-h-11 w-full rounded-sm border bg-background px-2" value={root ?? ""} onChange={event => graph.handleTraceNodeChange(event.target.value)}>
          {graph.nodeSelectOptions.map(node => <option key={node.id} value={node.id}>{node.symbol}</option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">Neighborhood and linked coins. Select a coin here instead of using small canvas targets.</p>
      {graph.nodes.length === 0 && <p className="text-sm text-muted-foreground">No coins are available in this neighborhood.</p>}
      <ul className="divide-y">
        {graph.nodes.filter(node => neighborhood.has(node.id)).map(node => (
          <li key={node.id} className="flex flex-wrap items-center gap-2">
            <button type="button" className="pharos-focus-ring min-h-11 flex-1 rounded-sm px-2 text-left text-sm" aria-pressed={graph.pinnedSelectionId === node.id} onClick={() => graph.handleNodeClick(node.id)}>{graphNodeLabel(node)}</button>
            {graph.onUseAsExposureRoot && <button type="button" data-use-exposure-root className="pharos-focus-ring min-h-11 rounded-sm border px-2 text-xs" onClick={() => graph.onUseAsExposureRoot?.(node.id)}>Use as exposure root</button>}
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <>
      {!isFullscreenOpen && (
        <Card className="overflow-hidden rounded-md border-border/70 bg-card shadow-none">
          <CardHeader className="space-y-3 border-b border-border/70 bg-background/25 pb-3">
            {modeControls}
            <p className="sr-only">Showing {graph.visibleNodeIds.size} of {graph.nodes.length} dependency-linked stablecoins with {graph.visibleLinks.length} visible edges.</p>
            <div className="hidden sm:block"><ContagionGraphHeader graph={graph} /></div>
            <button type="button" ref={openerRef} className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 text-xs sm:hidden" aria-haspopup="dialog" aria-expanded={isFullscreenOpen} onClick={() => {
              if (!graph.exposureOverlay) graph.setFocusMode("neighborhood");
              setTab("graph");
              trackEvent("dependency_map_action", { action: "fullscreen_open", value: "graph" });
              setIsFullscreenOpen(true);
            }}><Maximize2 className="size-4" aria-hidden="true" />Fullscreen graph</button>
          </CardHeader>
          <CardContent className="p-3 sm:p-4">
            <div className="sm:hidden">{list}</div>
            <div className="hidden sm:block">{stage}</div>
          </CardContent>
        </Card>
      )}
      <Dialog open={isFullscreenOpen} onOpenChange={setIsFullscreenOpen}>
        <DialogContent className="fixed inset-0 z-[70] flex h-auto w-auto max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-md p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:max-w-none" showCloseButton={false}
          onClickCapture={event => {
            if ((event.target as Element).closest("[data-use-exposure-root]")) {
              closingForRoot.current = true;
              setIsFullscreenOpen(false);
            }
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (!closingForRoot.current) openerRef.current?.focus();
            closingForRoot.current = false;
          }}>
          <div className="flex min-h-12 items-center justify-between gap-2 border-b px-3">
            <DialogTitle className="text-sm">Dependency map</DialogTitle>
            <DialogDescription className="sr-only">Graph and neighborhood list. Drag the background to pan. Touch selects coins; mouse-drag pins a coin. Fit resets the viewport. Press Escape to close.</DialogDescription>
            <div role="tablist" aria-label="Map view" className="flex gap-1">
              <button type="button" role="tab" aria-selected={tab === "list"} className="pharos-focus-ring min-h-11 min-w-11 px-2 text-xs" onClick={() => setTab("list")}>List</button>
              <button type="button" role="tab" aria-selected={tab === "graph"} className="pharos-focus-ring min-h-11 min-w-11 px-2 text-xs" onClick={() => setTab("graph")}>Graph</button>
            </div>
            <button type="button" aria-label="Close dependency map" className="pharos-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-md" onClick={() => setIsFullscreenOpen(false)}><X className="size-4" aria-hidden="true" /></button>
          </div>
          {modeControls}
          <div role="tabpanel" aria-label={tab === "graph" ? "Graph" : "List"} className="min-h-0 flex-1 overflow-y-auto">
            {tab === "graph" ? <>
              <details className="border-b px-3">
                <summary className="pharos-focus-ring flex min-h-11 cursor-pointer items-center text-xs">Graph filters and trace</summary>
                <ContagionGraphControls focusMode={graph.focusMode} edgeTypeFilter={graph.edgeTypeFilter} nodeLimit={graph.nodeLimit}
                  nodeSelectOptions={graph.nodeSelectOptions} selectedNeighborhoodId={graph.effectiveSelectedNeighborhoodId}
                  onFocusModeChange={graph.setFocusMode} onEdgeTypeFilterChange={graph.setEdgeTypeFilter}
                  onNodeLimitChange={graph.setNodeLimit} onTraceNodeChange={graph.handleTraceNodeChange} />
              </details>
              {stage}
            </> : list}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
