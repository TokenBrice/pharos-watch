"use client";

import { CohortCoinEmblems, summarizeCohort } from "@/app/alt-pegs/fiat-world-atlas/cohort-coin-emblems";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { SkyCohort } from "@/lib/alt-peg-hero";

export function MoonCohort({ cohort }: { cohort: SkyCohort }) {
  if (cohort.coins.length === 0) return null;
  const summary = summarizeCohort(cohort.coins);
  return (
    <div className="moon-cohort" aria-label="Silver stablecoins">
      <div className="moon-cohort__halo" style={{ left: "50%", top: "42%" }} />
      <CohortThreads coins={cohort.coins} colorHex="#cbd5e1" />
      <span className="sky-region-tag" style={{ left: "50%", top: "9%" }}>
        Silver · {summary.coinCount} {summary.coinCount === 1 ? "coin" : "coins"}
      </span>
      <CohortCoinEmblems
        coins={cohort.coins}
        cohortRank={cohort.rank}
        summary={summary}
        variant="moon"
        loading="eager"
        hoverCardYPlacement="below"
      />
    </div>
  );
}
