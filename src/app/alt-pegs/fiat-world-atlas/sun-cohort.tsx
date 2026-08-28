"use client";

import { CohortCoinEmblems, summarizeCohort } from "@/app/alt-pegs/fiat-world-atlas/cohort-coin-emblems";
import { CohortThreads } from "@/app/alt-pegs/fiat-world-atlas/cohort-threads";
import type { SkyCohort } from "@/lib/alt-peg-hero";

const SUN_HALO_PCT = { cx: 19, cy: 48 };

export function SunCohort({ cohort }: { cohort: SkyCohort }) {
  if (cohort.coins.length === 0) return null;
  const summary = summarizeCohort(cohort.coins);

  return (
    <div className="sun-cohort" aria-label="Gold stablecoins">
      <div className="sun-cohort__halo" style={{ left: `${SUN_HALO_PCT.cx}%`, top: `${SUN_HALO_PCT.cy}%` }} />
      <svg
        className="sun-cohort__rays"
        style={{ left: `${SUN_HALO_PCT.cx}%`, top: `${SUN_HALO_PCT.cy}%` }}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <g stroke="rgba(253,224,71,0.5)" strokeWidth={0.6}>
          <line x1="50" y1="5" x2="50" y2="20" />
          <line x1="50" y1="80" x2="50" y2="95" />
          <line x1="5" y1="50" x2="20" y2="50" />
          <line x1="80" y1="50" x2="95" y2="50" />
          <line x1="15" y1="15" x2="28" y2="28" />
          <line x1="72" y1="72" x2="85" y2="85" />
          <line x1="85" y1="15" x2="72" y2="28" />
          <line x1="15" y1="85" x2="28" y2="72" />
        </g>
      </svg>
      <CohortThreads coins={cohort.coins} colorHex="#facc15" />
      <span className="sky-region-tag" style={{ left: "19%", top: "9%" }}>
        Gold · {summary.coinCount} {summary.coinCount === 1 ? "coin" : "coins"}
      </span>
      <CohortCoinEmblems
        coins={cohort.coins}
        cohortRank={cohort.rank}
        summary={summary}
        variant={(_coin, index) => index < 2 ? "sun-core" : "sun-planet"}
        loading={(_coin, index) => index < 3 ? "eager" : "lazy"}
        hoverCardYPlacement="below"
      />
    </div>
  );
}
