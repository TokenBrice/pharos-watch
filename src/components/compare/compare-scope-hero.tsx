"use client";

import { useMemo } from "react";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CHART_PALETTE } from "@/lib/chart-colors";
import { COMPARISON_PRESETS, MAX_COMPARE_COINS, isComparePresetAvailable } from "@/lib/compare-config";
import { useWatchlist } from "@/hooks/use-watchlist";
import type { CoinOption } from "@/lib/compare-types";

const PEG_SEGMENT_COLORS = CHART_PALETTE.slice(1);
const MAX_PEG_SEGMENTS = 4;

function buildPegSegments(coinOptions: CoinOption[]) {
  const counts = new Map<string, number>();
  for (const option of coinOptions) {
    const peg = TRACKED_META_BY_ID.get(option.id)?.flags.pegCurrency ?? "OTHER";
    counts.set(peg, (counts.get(peg) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, MAX_PEG_SEGMENTS);
  const restCount = sorted.slice(MAX_PEG_SEGMENTS).reduce((sum, [, count]) => sum + count, 0);
  const segments = top.map(([peg, count], index) => ({
    label: peg,
    count,
    color: PEG_SEGMENT_COLORS[index % PEG_SEGMENT_COLORS.length],
  }));
  if (restCount > 0) {
    segments.push({
      label: "Other",
      count: restCount,
      color: PEG_SEGMENT_COLORS[MAX_PEG_SEGMENTS % PEG_SEGMENT_COLORS.length],
    });
  }
  return segments;
}

export function CompareScopeHero({
  coinOptions,
  selectedCount,
}: {
  coinOptions: CoinOption[];
  selectedCount: number;
}) {
  const { ids: watchlistIds } = useWatchlist();
  const visiblePresetCount = useMemo(
    () => COMPARISON_PRESETS.filter((preset) => isComparePresetAvailable(preset, watchlistIds)).length,
    [watchlistIds],
  );
  const segments = useMemo(() => buildPegSegments(coinOptions), [coinOptions]);
  const legend = segments.map((segment) => `${segment.count} ${segment.label}`).join(", ");

  return (
    <div
      role="group"
      aria-label="Comparison scope overview"
      className="pharos-card-shell flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span className="pharos-label">Active + frozen</span>
          <span className="pharos-numeric font-semibold text-foreground">{coinOptions.length}</span>
        </span>
        {segments.length > 0 ? (
          <div className="hidden items-center gap-2 md:flex">
            <div
              className="flex h-1.5 w-24 overflow-hidden rounded-full bg-border/40"
              role="img"
              aria-label={`Comparable coins by peg: ${legend}.`}
            >
              {segments.map((segment) => (
                <span
                  key={segment.label}
                  aria-hidden="true"
                  style={{ flexGrow: segment.count, backgroundColor: segment.color }}
                />
              ))}
            </div>
            <ul className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {segments.map((segment) => (
                <li key={segment.label} className="flex items-center gap-1 text-2xs text-muted-foreground">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: segment.color }} />
                  <span className="pharos-numeric font-medium text-foreground">{segment.count}</span>
                  <span>{segment.label}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="pharos-numeric font-semibold text-foreground">2–{MAX_COMPARE_COINS}</span> assets
        </span>
        <span aria-hidden="true" className="text-border">·</span>
        <span>
          <span className="pharos-numeric font-semibold text-foreground">{visiblePresetCount}</span> preset packs
        </span>
        <span aria-hidden="true" className="text-border">·</span>
        <span>
          <span className="pharos-numeric font-semibold text-foreground">{selectedCount}/{MAX_COMPARE_COINS}</span> selected
        </span>
      </div>
    </div>
  );
}
