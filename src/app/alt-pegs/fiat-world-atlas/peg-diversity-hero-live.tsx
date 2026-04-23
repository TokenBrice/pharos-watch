"use client";

import type { ReactNode } from "react";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import { SkyLayer } from "@/app/alt-pegs/fiat-world-atlas/sky-layer";
import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";

export function PegDiversityHeroLive({ worldMap }: { worldMap: ReactNode }) {
  const { data } = useStablecoins();
  const hero = buildPegDiversityHero(data?.peggedAssets);
  return (
    <HoverProvider>
      <div className="peg-hero">
        <SkyLayer cohorts={hero.skyCohorts} />
        <div className="peg-hero__earth">
          <div className="peg-hero__horizon" aria-hidden="true" />
          <div className="peg-hero__map-frame">
            {worldMap}
            <FiatEmblems clusters={hero.pegClusters} />
          </div>
        </div>
      </div>
    </HoverProvider>
  );
}
