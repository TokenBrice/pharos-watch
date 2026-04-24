"use client";

import { useState } from "react";
import { Maximize2 } from "lucide-react";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { AtlasFullscreenDialog } from "@/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import "./peg-hero.css";

function AtlasHeroHeader({
  onExpand,
  open,
}: {
  onExpand: () => void;
  open: boolean;
}) {
  return (
    <div className="relative z-10 flex items-center justify-between gap-3 px-4 pt-4 pb-3 sm:px-5 sm:pt-5 sm:pb-4 lg:px-6">
      <h2
        id="alt-peg-link-hub"
        className="text-lg font-semibold tracking-tight text-frost-blue/95 sm:text-xl lg:text-[1.45rem]"
      >
        Peg Diversity Atlas
      </h2>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Expand atlas"
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={onExpand}
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Expand atlas</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function FiatWorldAtlas(_props: {
  fiatItems: readonly AltPegLinkHubItem[];
  commodityIndexItems: readonly AltPegLinkHubItem[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <section
      aria-labelledby="alt-peg-link-hub"
      className="relative overflow-hidden rounded-[1.45rem] border border-border/70 bg-card/92 text-foreground shadow-[0_22px_60px_oklch(0_0_0_/0.12)] dark:border-white/10 dark:bg-[oklch(0.105_0.012_248)] dark:text-white dark:shadow-[0_26px_70px_oklch(0_0_0_/0.22)]"
    >
      <AtlasHeroHeader onExpand={() => setOpen(true)} open={open} />

      <div data-alt-peg-layout="responsive-atlas" className="block">
        <a
          href="#alt-peg-history-share"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
        >
          Skip peg map
        </a>
        <div className="peg-hero__viewport" role="group" aria-label="Peg diversity map atlas">
          <PegDiversityHeroLive worldMap={<WorldMap />} />
        </div>
      </div>

      <AtlasFullscreenDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}
