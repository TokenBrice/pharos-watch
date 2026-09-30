"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { ContagionGraphHeader } from "@/components/contagion-graph/contagion-graph-header";
import type { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { trackEvent } from "@/lib/analytics";

interface ContagionGraphShellProps {
  graph: ReturnType<typeof useContagionGraphModel>;
  stage: ReactNode;
}

export function ContagionGraphShell({ graph, stage }: ContagionGraphShellProps) {
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);

  const openerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(min-width: 640px)");
    const closeOnDesktop = () => { if (media.matches) setIsFullscreenOpen(false); };
    media.addEventListener("change", closeOnDesktop);
    closeOnDesktop();
    return () => media.removeEventListener("change", closeOnDesktop);
  }, [isFullscreenOpen]);
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
            ref={openerRef}
            className="pharos-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border/70 bg-background/80 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground transition-colors hover:bg-muted/40 sm:hidden"
            aria-haspopup="dialog"
            aria-expanded={isFullscreenOpen}
            onClick={() => {
              trackEvent("dependency_map_action", { action: "fullscreen_open", value: "graph" });
              setIsFullscreenOpen(true);
            }}
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
      {!isFullscreenOpen && renderCard(false)}
      <Dialog open={isFullscreenOpen} onOpenChange={setIsFullscreenOpen}>
        <DialogContent
          className="fixed left-0 right-0 top-0 bottom-0 z-[70] flex h-auto w-auto max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-md border-border/70 p-0 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pl-[calc(env(safe-area-inset-left)+0.5rem)] pr-[calc(env(safe-area-inset-right)+0.5rem)] sm:max-w-none"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus();
          }}
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
