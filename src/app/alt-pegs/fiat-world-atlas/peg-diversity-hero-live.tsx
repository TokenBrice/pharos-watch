"use client";

import { useMemo, type ReactNode } from "react";
import { formatCompactUsd } from "@shared/lib/format";
import {
  coinEmblemSize,
  FIAT_MAP_SIZE_CEIL,
  SHELF_SIZE_CEIL,
  sizeCapMarketCap,
} from "@/lib/alt-peg-sizing";
import { buildPegDiversityHero } from "@/lib/alt-peg-hero";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { HoverProvider } from "@/app/alt-pegs/fiat-world-atlas/hover-context";
import { OffMapShelf } from "@/app/alt-pegs/fiat-world-atlas/off-map-shelf";
import { FiatEmblems } from "@/app/alt-pegs/fiat-world-atlas/fiat-emblems";

function formatSizeStep(value: number): string {
  return formatCompactUsd(value).replace(/\.0+(?=[KMBT]$)/u, "");
}

function formatCeiling(value: number): string {
  return `~${formatSizeStep(Math.round(value / 10_000_000) * 10_000_000)}`;
}

/** "~$1.2B": where map emblems stop growing (named in the atlas subtitle and the key). */
export const MAP_SIZE_CAP_LABEL = formatCeiling(sizeCapMarketCap(FIAT_MAP_SIZE_CEIL));

const SIZE_KEY_STEPS = [1_000_000, 25_000_000, 100_000_000, 500_000_000] as const;

/** One sqrt scale for every emblem; the map and the shelf only stop growing at different caps. */
function SizeKey() {
  return (
    <div className="peg-hero__scale-key" aria-label="Emblem size key">
      <span className="peg-hero__scale-title">Size is market cap</span>
      {SIZE_KEY_STEPS.map((value) => {
        const size = coinEmblemSize(value, { ceil: SHELF_SIZE_CEIL });
        return (
          <span key={value} className="peg-hero__scale-item">
            <span className="peg-hero__scale-dot" style={{ width: `calc(${size}px * var(--peg-coin-scale, 1))`, height: `calc(${size}px * var(--peg-coin-scale, 1))` }} aria-hidden="true" />
            <span className="pharos-numeric">{formatSizeStep(value)}</span>
          </span>
        );
      })}
      <span className="peg-hero__scale-note">
        Map emblems stop growing at <span className="pharos-numeric">{MAP_SIZE_CAP_LABEL}</span>,
        shelf emblems at <span className="pharos-numeric">{formatCeiling(sizeCapMarketCap(SHELF_SIZE_CEIL))}</span>
      </span>
      <span className="peg-hero__scale-item">
        <span className="peg-hero__scale-dot peg-hero__scale-dot--unavailable" style={{ width: 20, height: 20 }} aria-hidden="true" />
        Supply unavailable
      </span>
    </div>
  );
}

export function PegDiversityHeroLive({
  worldMap,
  variant = "default",
}: {
  worldMap: ReactNode;
  variant?: "default" | "fullscreen";
}) {
  const stablecoinsQuery = useStablecoins();
  const { data } = stablecoinsQuery;
  const peggedAssets = data?.peggedAssets;
  const hero = useMemo(() => buildPegDiversityHero(peggedAssets), [peggedAssets]);
  // Retained positions stay drawn through a failed refresh; only settled absence is unavailable.
  const renderable = !!peggedAssets?.length;
  const showStatusOverlay = !renderable;
  const statusCopy = stablecoinsQuery.isLoading
    ? "Loading live coin positions."
    : "Live coin layer unavailable; the ranking and table below still list every peg.";

  return (
    <HoverProvider>
      <div
        className={
          variant === "fullscreen"
            ? "peg-hero__live-shell peg-hero__live-shell--fullscreen"
            : "peg-hero__live-shell"
        }
      >
        {/* The default view sits under the page's stablecoins banner; the dialog needs its own. */}
        {variant === "fullscreen" && renderable ? (
          <div className="mb-3 empty:hidden">
            <StaleDataBanner
              queries={[{
                preset: "stablecoins",
                dataUpdatedAt: stablecoinsQuery.dataUpdatedAt,
                isLoading: stablecoinsQuery.isLoading,
                error: stablecoinsQuery.error,
                hasData: true,
                meta: stablecoinsQuery.meta,
              }]}
            />
          </div>
        ) : null}
        <div className={variant === "fullscreen" ? "peg-hero peg-hero--fullscreen" : "peg-hero"}>
          {showStatusOverlay ? (
            <div className="peg-hero__status-overlay" role="status" aria-live="polite">
              {statusCopy}
            </div>
          ) : null}
          <OffMapShelf groups={hero.shelfGroups} />
          <div className="peg-hero__earth">
            <div className="peg-hero__map-frame">
              {worldMap}
              <FiatEmblems clusters={hero.pegClusters} />
            </div>
          </div>
        </div>
        <SizeKey />
      </div>
    </HoverProvider>
  );
}
