"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { formatCompactUsd, formatPercent } from "@shared/lib/format";
import { coinEmblemSize, FIAT_MAP_SIZE_CAP_MARKET_CAP, FIAT_MAP_SIZE_CEIL } from "@/lib/alt-peg-sizing";
import { buildAltPegSnapshot } from "@/lib/alt-peg-market";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import { SkyLayer } from "@/app/alt-pegs/fiat-world-atlas/sky-layer";
import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";

function formatFriendlyCap(value: number): string {
  const rounded = Math.max(100_000_000, Math.round(value / 100_000_000) * 100_000_000);
  const compact = formatCompactUsd(rounded).replace(/\.0+(?=[KMBT]$)/u, "");
  return `~${compact}`;
}

function formatSizeStep(value: number): string {
  return formatCompactUsd(value).replace(/\.0+(?=[KMBT]$)/u, "");
}

const FIAT_SIZE_KEY_STEPS = [
  { value: 1_000_000, label: "$1M" },
  { value: 25_000_000, label: "$25M" },
  { value: 100_000_000, label: "$100M" },
  { value: 200_000_000, label: "$200M" },
  { value: FIAT_MAP_SIZE_CAP_MARKET_CAP, label: `${formatFriendlyCap(FIAT_MAP_SIZE_CAP_MARKET_CAP)}+` },
] as const;

function FiatSizeKey() {
  return (
    <div className="peg-hero__scale-key" aria-label="Fiat market cap size key">
      <span className="peg-hero__scale-label">Fiat logo size</span>
      {FIAT_SIZE_KEY_STEPS.map(({ value, label }) => {
        const dotSize = Math.max(7, Math.round(coinEmblemSize(value, { ceil: FIAT_MAP_SIZE_CEIL }) / 2));
        return (
          <span key={label} className="peg-hero__scale-item" title={`${formatSizeStep(value)} market cap`}>
            <span className="peg-hero__scale-dot" style={{ width: dotSize, height: dotSize }} />
            {label}
          </span>
        );
      })}
    </div>
  );
}

function TopCohortStrip({ rows }: { rows: ReturnType<typeof buildAltPegSnapshot>["topRows"] }) {
  if (rows.length === 0) return null;
  return (
    <div className="peg-hero__top-cohorts" aria-label="Top cohorts by market cap">
      <span className="peg-hero__top-label">Largest cohorts</span>
      {rows.map((row, index) => (
        <Link key={row.peg} href={row.href} className="peg-hero__top-row pharos-focus-ring">
          <span className="peg-hero__top-dot" style={{ backgroundColor: row.colorHex }} />
          <span className="peg-hero__top-name">
            #{index + 1} {row.label}
          </span>
          <span className="peg-hero__top-value">
            {formatCompactUsd(row.marketCap)} · {formatPercent(row.sharePct, 1)}
            <span className="peg-hero__top-value-context"> of non-USD cap</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

export function PegDiversityHeroLive({ worldMap }: { worldMap: ReactNode }) {
  const stablecoinsQuery = useStablecoins();
  const { data } = stablecoinsQuery;
  const peggedAssets = data?.peggedAssets;
  const hero = useMemo(() => buildPegDiversityHero(peggedAssets), [peggedAssets]);
  const snapshot = useMemo(() => buildAltPegSnapshot(peggedAssets), [peggedAssets]);
  const showStatusOverlay = !data?.peggedAssets?.length || stablecoinsQuery.isError;
  const statusCopy =
    stablecoinsQuery.isError || (!stablecoinsQuery.isLoading && !data?.peggedAssets?.length)
      ? "Live coin layer unavailable; cohort links remain below."
      : "Loading live coin positions.";

  return (
    <HoverProvider>
      <div className="peg-hero__live-shell">
        <div className="peg-hero__legend-rail">
          <FiatSizeKey />
          <TopCohortStrip rows={snapshot.topRows} />
        </div>
        <div className="peg-hero">
          {showStatusOverlay ? (
            <div className="peg-hero__status-overlay" role="status" aria-live="polite">
              {statusCopy}
            </div>
          ) : null}
          <SkyLayer cohorts={hero.skyCohorts} />
          <div className="peg-hero__earth">
            <div className="peg-hero__horizon" aria-hidden="true" />
            <div className="peg-hero__map-frame">
              {worldMap}
              <FiatEmblems clusters={hero.pegClusters} />
            </div>
          </div>
        </div>
      </div>
    </HoverProvider>
  );
}
