"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Maximize2, X } from "lucide-react";
import { ContagionGraphHeader } from "@/components/contagion-graph/contagion-graph-header";
import type { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface ContagionGraphShellProps {
  graph: ReturnType<typeof useContagionGraphModel>;
  stage: ReactNode;
}

export function ContagionGraphShell({ graph, stage }: ContagionGraphShellProps) {
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);

  // Both slots render the same `stage` node against the same model, so the fullscreen
  // dialog neither re-runs the d3 simulation nor forks the graph's filter/selection state.
  const renderCard = (fullscreenMode: boolean) => (
    <Card
      className={
        fullscreenMode
          ? "flex h-full min-h-0 flex-col overflow-hidden rounded-md border-border/70 bg-card shadow-none"
          : "overflow-hidden rounded-md border-border/70 bg-card shadow-none"
      }
    >
      <CardHeader className="space-y-3 border-b border-border/70 bg-background/25 pb-3">
        <p className="sr-only">
          Showing {graph.visibleNodeIds.size} of {graph.nodes.length} dependency-linked stablecoins with{" "}
          {graph.visibleLinks.length} visible edges.
        </p>
        {fullscreenMode ? null : (
          <button
            type="button"
            className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border/70 bg-background/80 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground transition-colors hover:bg-muted/40 sm:hidden"
            aria-haspopup="dialog"
            aria-expanded={isFullscreenOpen}
            onClick={() => setIsFullscreenOpen(true)}
          >
            <Maximize2 className="size-4" aria-hidden="true" />
            Fullscreen graph
          </button>
        )}
        <ContagionGraphHeader graph={graph} />
      </CardHeader>
      <CardContent className={fullscreenMode ? "min-h-0 flex-1 overflow-y-auto p-3 sm:p-4" : "p-3 sm:p-4"}>
        {stage}
      </CardContent>
    </Card>
  );

  return (
    <>
      {renderCard(false)}
      <Dialog open={isFullscreenOpen} onOpenChange={setIsFullscreenOpen}>
        <DialogContent
          className="fixed inset-2 left-2 top-2 flex h-auto w-auto max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-md border-border/70 p-0 sm:hidden"
          showCloseButton={false}
        >
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border/70 bg-background/95 px-3 py-2">
            <div>
              <DialogTitle className="font-mono text-xs uppercase tracking-[0.16em] text-foreground">
                Dependency map
              </DialogTitle>
              <DialogDescription className="sr-only">
                Fullscreen dependency graph inspection mode. Tap nodes to inspect dependencies. Press Escape to close.
              </DialogDescription>
            </div>
            <button
              type="button"
              aria-label="Close dependency map"
              className="pharos-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              onClick={() => setIsFullscreenOpen(false)}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{renderCard(true)}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}
