"use client";

import { CoinEmblem } from "@/app/alt-pegs/fiat-world-atlas/coin-emblem";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { SkyCohort } from "@/lib/alt-peg-hero";

export function MoonCohort({ cohort }: { cohort: SkyCohort }) {
  if (cohort.coins.length === 0) return null;
  return (
    <div className="moon-cohort" aria-label="Silver stablecoins">
      <div className="moon-cohort__halo" style={{ left: "50%", top: "42%" }} />
      <CohortThreads coins={cohort.coins} colorHex="#cbd5e1" />
      <span className="sky-region-tag" style={{ left: "50%", top: "9%" }}>
        Silver · Moon
      </span>
      {cohort.coins.map((c) => (
        <CoinEmblem key={c.id} coin={c} variant="moon" loading="eager" />
      ))}
    </div>
  );
}
