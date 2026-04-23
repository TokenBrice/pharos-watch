"use client";

import type { ReactNode } from "react";
import { formatCompactUsd, formatPercent } from "@shared/lib/format";
import { FIAT_MAP_SIZE_CAP_MARKET_CAP } from "@/lib/alt-peg-sizing";
import { buildAltPegSnapshot } from "@/lib/alt-peg-market";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import { SkyLayer } from "@/app/alt-pegs/fiat-world-atlas/sky-layer";
import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";

function FiatSizeKey() {
  return (
    <div className="peg-hero__scale-key" aria-label="Fiat market cap size key">
      <span className="peg-hero__scale-label">Fiat size</span>
      <span className="peg-hero__scale-item">
        <span className="peg-hero__scale-dot" style={{ width: 7, height: 7 }} />
        $1M
      </span>
      <span className="peg-hero__scale-item">
        <span className="peg-hero__scale-dot" style={{ width: 12, height: 12 }} />
        $100M
      </span>
      <span className="peg-hero__scale-item">
        <span className="peg-hero__scale-dot" style={{ width: 16, height: 16 }} />
        {formatCompactUsd(FIAT_MAP_SIZE_CAP_MARKET_CAP)}+ cap
      </span>
    </div>
  );
}

function TopCohortStrip({ rows }: { rows: ReturnType<typeof buildAltPegSnapshot>["topRows"] }) {
  if (rows.length === 0) return null;
  return (
    <div className="peg-hero__top-cohorts" aria-label="Top cohorts by market cap">
      <span className="peg-hero__top-label">Top cohorts by cap</span>
      {rows.map((row) => (
        <span key={row.peg} className="peg-hero__top-row">
          <span className="peg-hero__top-dot" style={{ backgroundColor: row.colorHex }} />
          <span className="peg-hero__top-name">{row.label}</span>
          <span className="peg-hero__top-value">
            {formatCompactUsd(row.marketCap)} · {formatPercent(row.sharePct, 1)}
          </span>
        </span>
      ))}
    </div>
  );
}

export function PegDiversityHeroLive({ worldMap }: { worldMap: ReactNode }) {
  const { data } = useStablecoins();
  const hero = buildPegDiversityHero(data?.peggedAssets);
  const snapshot = buildAltPegSnapshot(data?.peggedAssets);
  return (
    <HoverProvider>
      <div className="peg-hero">
        <TopCohortStrip rows={snapshot.topRows} />
        <FiatSizeKey />
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
