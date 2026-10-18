"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ChartSkeleton } from "@/components/chart-skeleton";
import type { ReserveCompositionSlice } from "@/components/stablecoin-detail/reserve-presentation";
import {
  RESERVE_TREEMAP_LABEL_COLOR,
  RISK_ACCENT_COLORS,
  RISK_COLORS,
} from "@/lib/chart-colors";
import type { ReserveRisk } from "@shared/types";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";
import { ReserveRiskSwatch, formatReserveRiskTier, formatReserveSharePct } from "@/components/reserve-risk-swatch";

// Only the actual multi-slice chart loads Recharts; bars and the accessible
// composition figure remain synchronous, including while this chunk loads.
const ReserveTreemapChart = dynamic(
  () => import("@/components/reserve-treemap-chart").then((mod) => mod.ReserveTreemapChart),
  { loading: () => <ChartSkeleton className="h-full w-full" /> },
);

interface ReserveTreemapProps {
  slices: readonly ReserveCompositionSlice[];
  /** What the figure shows, for its accessible name: "Reviewed reserve slices". */
  subject: string;
}

/**
 * A basket whose largest slice holds at least this share is drawn as a single
 * labelled bar: a treemap of a 92% tile plus crumbs is a giant rectangle that
 * encodes nothing a bar does not. A one-slice basket gets `SingleSliceBar`.
 */
const DOMINANT_SLICE_MIN_PCT = 90;

/** Below this share a lone reviewed slice leaves a visible, dashed unreviewed remainder. */
const FULL_COMPOSITION_MIN_PCT = 99.5;

/** Only the tiers actually drawn are keyed; every tile tone has a swatch. */
function RiskLegend({ risks }: { risks: readonly ReserveRisk[] }) {
  return (
    <ul aria-label="Reserve risk tiers" className="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      {risks.map((risk) => (
        <li key={risk} className="flex min-w-0 items-center gap-1.5">
          <ReserveRiskSwatch risk={risk} />
          <span className="text-2xs font-medium text-muted-foreground">{formatReserveRiskTier(risk)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One labelled bar for a basket a single slice dominates. The leading segment
 * carries its full name (wrapped, never ellipsised); every remaining slice is
 * listed beneath with its swatch, so no share is unlabeled.
 */
function DominantSliceBar({ slices }: { slices: readonly ReserveCompositionSlice[] }) {
  const [top, ...rest] = slices;
  if (!top) return null;
  return (
    <div>
      <div className="flex min-h-12 w-full gap-0.5 overflow-hidden rounded-md">
        {slices.map((slice, index) => (
          <div
            key={slice.key}
            title={`${slice.label} · ${formatReserveSharePct(slice.pct)}`}
            className="flex min-w-[3px] items-center px-3 py-2"
            style={{
              width: `${slice.pct}%`,
              backgroundColor: RISK_COLORS[slice.risk],
              boxShadow: `inset 0 0 0 1px ${RISK_ACCENT_COLORS[slice.risk]}80`,
            }}
          >
            {index === 0 ? (
              <span className="min-w-0 text-xs font-semibold leading-snug" style={{ color: RESERVE_TREEMAP_LABEL_COLOR }}>
                {slice.label}
                <span className="font-mono tabular-nums"> · {formatReserveSharePct(slice.pct)}</span>
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {rest.length > 0 ? (
        <ul aria-label="Other reserve slices" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {rest.map((slice) => (
            <li key={slice.key} className="flex items-center gap-1.5">
              <ReserveRiskSwatch risk={slice.risk} />
              {slice.label}
              <span className="font-mono tabular-nums text-foreground">{formatReserveSharePct(slice.pct)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A basket that is one reviewed slice. A treemap of one tile, or a bare 100%
 * bar, encodes nothing, so the slice reads as one compact composition bar that
 * carries its name and share, with its risk tier and reviewed asset class on
 * the line beneath. A share short of the whole leaves a dashed remainder:
 * unreviewed, never drawn as filled.
 */
function SingleSliceBar({ slice }: { slice: ReserveCompositionSlice }) {
  const ink = RESERVE_TREEMAP_LABEL_COLOR;
  const isWhole = slice.pct >= FULL_COMPOSITION_MIN_PCT;
  return (
    <div className="min-w-0">
      <div className="flex min-h-9 w-full gap-0.5 overflow-hidden rounded-md">
        <div
          className="flex min-w-0 items-center justify-between gap-3 px-3 py-1.5"
          style={{
            width: isWhole ? "100%" : `${slice.pct}%`,
            backgroundColor: RISK_COLORS[slice.risk],
            boxShadow: `inset 0 0 0 1px ${RISK_ACCENT_COLORS[slice.risk]}80`,
          }}
        >
          <span className="min-w-0 text-xs font-semibold leading-snug" style={{ color: ink }}>
            {slice.label}
          </span>
          <span className="shrink-0 font-mono text-2xs font-semibold tabular-nums" style={{ color: ink }}>
            {formatReserveSharePct(slice.pct)}
          </span>
        </div>
        {isWhole ? null : (
          <div
            title="Not covered by the reviewed composition"
            className="min-w-[3px] flex-1 rounded-md border border-dashed border-muted-foreground/50"
          />
        )}
      </div>
      <dl className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center">
          <dt className="sr-only">Risk tier</dt>
          <dd className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
            <ReserveRiskSwatch risk={slice.risk} />
            {formatReserveRiskTier(slice.risk)}
          </dd>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="text-muted-foreground">Asset class</dt>
          <dd className="min-w-0 text-foreground" title={slice.role ? undefined : "Asset class not classified by the review"}>
            {slice.role ?? "–"}
          </dd>
        </div>
        {isWhole ? null : (
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Unreviewed remainder</dt>
            <dd className="font-mono tabular-nums text-foreground">{formatReserveSharePct(100 - slice.pct)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/**
 * The module's one reserve visual, toned by risk tier. Renders flat (no card
 * chrome; the Reserves module owns the shell). A one-slice basket is a compact
 * composition bar, a dominated basket a labelled bar
 * (`DOMINANT_SLICE_MIN_PCT`); everything else is a treemap.
 */
export function ReserveTreemap({ slices, subject }: ReserveTreemapProps) {
  const data = useMemo(
    () => slices.filter((slice) => Number.isFinite(slice.pct) && slice.pct > 0).sort((a, b) => b.pct - a.pct),
    [slices],
  );
  const presentRisks = useMemo(
    () => (Object.keys(RESERVE_RISK_PRESENTATION) as ReserveRisk[]).filter((risk) => data.some((slice) => slice.risk === risk)),
    [data],
  );
  const { ref: chartViewportRef, near: chartNear } = useNearViewport<HTMLDivElement>();

  const [top] = data;
  if (!top) return null;

  if (data.length === 1) {
    const role = top.role ? `, ${top.role}` : "";
    return (
      <div
        role="figure"
        aria-label={`${subject}: ${top.label} ${formatReserveSharePct(top.pct)}, ${RESERVE_RISK_PRESENTATION[top.risk].longLabel}${role}`}
        className="min-w-0"
      >
        <SingleSliceBar slice={top} />
      </div>
    );
  }

  const ariaLabel = `${subject}: ${data.map((slice) => `${slice.label} ${formatReserveSharePct(slice.pct)}`).join(", ")}`;
  const isDominated = top.pct >= DOMINANT_SLICE_MIN_PCT;

  return (
    <div className="min-w-0">
      {isDominated ? (
        <div role="figure" aria-label={ariaLabel}>
          <DominantSliceBar slices={data} />
        </div>
      ) : (
        <div className="h-64 w-full min-w-0 overflow-hidden sm:h-72">
          <div ref={chartViewportRef} className="h-full min-w-0 overflow-hidden" role="figure" aria-label={ariaLabel}>
            {chartNear ? <ReserveTreemapChart data={data} /> : <ChartSkeleton className="h-full w-full" />}
          </div>
        </div>
      )}
      <RiskLegend risks={presentRisks} />
    </div>
  );
}
