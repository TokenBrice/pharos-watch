"use client";

import { useState } from "react";
import { ChevronDown, Maximize2 } from "lucide-react";
import { MAP_SIZE_CAP_LABEL, PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { AtlasFullscreenDialog } from "@/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import "./peg-hero.css";

function AtlasHeader({
  onExpand,
  open,
}: {
  onExpand: () => void;
  open: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-1">
        <h2 id="alt-peg-link-hub" className="pharos-section-title">
          Peg diversity atlas
        </h2>
        <p className="pharos-meta">Every core non-USD coin at its peg&apos;s home. Size is market cap, capped at {MAP_SIZE_CAP_LABEL} on the map; crowded homes stack.</p>
      </div>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="hidden md:inline-flex"
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

/**
 * The atlas band: on the page ground in light mode, a night sea in dark mode
 * (peg-hero.css scene tokens). Phones get it behind a disclosure, since its
 * emblems are too small to inspect there and the ranking above carries the facts.
 */
export function FiatWorldAtlas() {
  const [open, setOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);

  return (
    <section aria-labelledby="alt-peg-link-hub" className="peg-atlas space-y-4 border-t border-border/50 pt-5">
      <AtlasHeader onExpand={() => setOpen(true)} open={open} />

      <button
        type="button"
        className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground md:hidden"
        aria-expanded={phoneOpen}
        aria-controls="alt-peg-atlas-body"
        onClick={() => setPhoneOpen((value) => !value)}
      >
        {phoneOpen ? "Hide map" : "Show map"}
        <ChevronDown className={phoneOpen ? "h-4 w-4 rotate-180 transition-transform" : "h-4 w-4 transition-transform"} aria-hidden="true" />
      </button>

      <div
        id="alt-peg-atlas-body"
        data-alt-peg-layout="responsive-atlas"
        className={phoneOpen ? "block" : "hidden md:block"}
      >
        <a
          href="#alt-peg-ranking"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-skip focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
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
