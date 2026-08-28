"use client";

import { CohortCoinEmblems, summarizeCohort } from "@/app/alt-pegs/fiat-world-atlas/cohort-coin-emblems";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { SkyCohort } from "@/lib/alt-peg-hero";

export function ConstellationCohort({ cohort }: { cohort: SkyCohort }) {
  if (cohort.coins.length === 0) return null;
  const summary = summarizeCohort(cohort.coins);
  return (
    <div className="constellation-cohort" aria-label={`${cohort.label}-linked stablecoins`}>
      <svg className="constellation-cohort__traces" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {cohort.coins.slice(1).map((c, idx) => {
          const prev = cohort.coins[idx];
          return (
            <line
              key={`${prev.id}-${c.id}`}
              x1={prev.x}
              y1={prev.y}
              x2={c.x}
              y2={c.y}
              stroke="rgba(200,215,255,0.4)"
              strokeWidth={0.3}
              strokeDasharray="0.6 1.2"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <CohortThreads coins={cohort.coins} colorHex="#a8bae0" />
      <span className="sky-region-tag" style={{ left: "82%", top: "9%" }}>
        CPI · {summary.coinCount} {summary.coinCount === 1 ? "coin" : "coins"}
      </span>
      <CohortCoinEmblems
        coins={cohort.coins}
        cohortRank={cohort.rank}
        summary={summary}
        variant="star"
        loading="eager"
        hoverCardYPlacement="below"
      />
    </div>
  );
}
