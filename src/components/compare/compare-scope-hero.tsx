"use client";

import { useMemo } from "react";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { CHART_PALETTE } from "@/lib/chart-colors";
import { COMPARISON_PRESETS, MAX_COMPARE_COINS } from "@/lib/compare-config";
import type { CoinOption } from "@/lib/compare-types";

// ---------------------------------------------------------------------------
// CompareScopeHero — FeatureHeroSplit hero band for the compare hub. One Beam =
// the size of the comparable registry (a neutral magnitude, so it takes the
// frost recipe); the right slot decomposes that universe by peg currency with
// the flat proportional-bar idiom. Frost stays the beam: segments use the
// non-frost CHART_PALETTE sequence tones.
// ---------------------------------------------------------------------------

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
      label: "Other pegs",
      count: restCount,
      color: PEG_SEGMENT_COLORS[MAX_PEG_SEGMENTS % PEG_SEGMENT_COLORS.length],
    });
  }
  return segments;
}

function CompareHeroMetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="min-w-0 truncate text-sm text-muted-foreground">{label}</span>
      <span className="pharos-numeric shrink-0 text-sm font-semibold text-foreground">{value}</span>
    </div>
  );
}

export function CompareScopeHero({
  coinOptions,
  selectedCount,
}: {
  coinOptions: CoinOption[];
  selectedCount: number;
}) {
  const segments = useMemo(() => buildPegSegments(coinOptions), [coinOptions]);
  const legend = segments.map((segment) => `${segment.count} ${segment.label}`).join(", ");

  return (
    <FeatureHeroSplit
      ariaLabel="Comparison scope overview"
      beamLabel="Active + frozen"
      beamValue={coinOptions.length}
      subKicker="Set Scope"
      sub={
        <div className="divide-y divide-border/50">
          <CompareHeroMetricRow label="Assets per set" value="2–5" />
          <CompareHeroMetricRow label="Preset packs" value={String(COMPARISON_PRESETS.length)} />
          <CompareHeroMetricRow label="Selected now" value={`${selectedCount}/${MAX_COMPARE_COINS}`} />
        </div>
      }
    >
      <div className="flex h-full flex-col justify-center space-y-3 p-5 sm:p-6 lg:p-7">
        <p className="pharos-label">Comparable coins by peg</p>
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-border/40"
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
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {segments.map((segment) => (
            <li key={segment.label} className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ backgroundColor: segment.color }} />
              <span className="pharos-numeric text-xs font-semibold text-foreground">{segment.count}</span>
              <span className="text-2xs text-muted-foreground">{segment.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </FeatureHeroSplit>
  );
}
