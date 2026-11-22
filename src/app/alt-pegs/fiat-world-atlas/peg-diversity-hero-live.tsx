"use client";

import { useMemo, type ReactNode } from "react";
import { PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { PegCurrency } from "@shared/types/core";
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
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";

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
  selectedPeg = null,
  onSelectPeg,
}: {
  worldMap?: ReactNode;
  variant?: "default" | "fullscreen";
  selectedPeg?: PegCurrency | null;
  onSelectPeg?: (peg: PegCurrency | null) => void;
}) {
  const stablecoinsQuery = useStablecoins();
  const { data } = stablecoinsQuery;
  const peggedAssets = data?.peggedAssets;
  const hero = useMemo(() => buildPegDiversityHero(peggedAssets), [peggedAssets]);
  const activeMapPegs = useMemo(() => hero.pegClusters.map((cluster) => cluster.peg), [hero.pegClusters]);
  const regionChips = useMemo(() => {
    const items = [
      ...hero.pegClusters.map((cluster) => ({
        peg: cluster.peg,
        label: PEG_LABELS_SHORT[cluster.peg] ?? cluster.peg,
        colorHex: cluster.colorHex,
        marketCap: cluster.cohort.marketCap ?? -1,
      })),
      ...hero.shelfGroups.map((group) => ({
        peg: group.peg,
        label: group.label,
        colorHex: group.colorHex,
        marketCap: group.cohort.marketCap ?? -1,
      })),
    ];
    return items.sort((a, b) => b.marketCap - a.marketCap || a.label.localeCompare(b.label));
  }, [hero.pegClusters, hero.shelfGroups]);

  // Retained positions stay drawn through a failed refresh; only settled absence is unavailable.
  const renderable = !!peggedAssets?.length;
  const showStatusOverlay = !renderable;
  const statusCopy = stablecoinsQuery.isLoading
    ? "Loading live coin positions."
    : "Live coin layer unavailable; the ranking and table below still list every peg.";

  const resolvedWorldMap =
    worldMap !== undefined ? (
      worldMap
    ) : (
      <WorldMap
        selectedPeg={selectedPeg}
        activePegs={activeMapPegs}
        onSelectPeg={onSelectPeg}
      />
    );

  return (
    <HoverProvider selectedPeg={selectedPeg}>
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
          <OffMapShelf
            groups={hero.shelfGroups}
            selectedPeg={selectedPeg}
            onSelectPeg={onSelectPeg}
          />
          <div className="peg-hero__earth">
            <div className="peg-hero__map-frame">
              {resolvedWorldMap}
              <FiatEmblems clusters={hero.pegClusters} />
            </div>
          </div>
        </div>
        {onSelectPeg && regionChips.length > 0 ? (
          <div
            role="group"
            aria-label="Filter by currency region"
            className="mt-2.5 flex flex-wrap items-center gap-1.5"
          >
            <button
              type="button"
              aria-pressed={selectedPeg === null}
              onClick={() => onSelectPeg(null)}
              className={
                selectedPeg === null
                  ? "pharos-focus-ring pharos-control-pill pharos-control-pill-active min-h-11 text-xs md:min-h-7"
                  : "pharos-focus-ring pharos-control-pill min-h-11 text-xs md:min-h-7"
              }
            >
              All pegs
            </button>
            {regionChips.map((item) => {
              const isSelected = selectedPeg === item.peg;
              return (
                <button
                  key={item.peg}
                  type="button"
                  aria-label={`Filter atlas by ${item.label}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelectPeg(isSelected ? null : item.peg)}
                  className={
                    isSelected
                      ? "pharos-focus-ring pharos-control-pill pharos-control-pill-active min-h-11 gap-1.5 text-xs md:min-h-7"
                      : "pharos-focus-ring pharos-control-pill min-h-11 gap-1.5 text-xs md:min-h-7"
                  }
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.colorHex }}
                    aria-hidden="true"
                  />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <SizeKey />
      </div>
    </HoverProvider>
  );
}
