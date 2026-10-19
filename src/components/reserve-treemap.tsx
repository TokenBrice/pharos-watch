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
  /** Fold labels/details only; every slice still contributes to the layout. */
  labelLimit?: number;
}

/**
 * A basket whose largest slice holds at least this share is drawn as a single
 * labelled bar: a treemap of a 92% tile plus crumbs is a giant rectangle that
 * encodes nothing a bar does not. A one-slice basket gets `SingleSliceBar`.
 */
const DOMINANT_SLICE_MIN_PCT = 90;

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
function DominantSliceBar({
  slices, unreviewedPct, labelLimit,
}: { slices: readonly ReserveCompositionSlice[]; unreviewedPct: number; labelLimit: number }) {
  const [top, ...rest] = slices.slice(0, labelLimit);
  if (!top) return null;
  return (
    <div>
      <div className="flex min-h-12 w-full overflow-hidden rounded-md">
        {slices.map((slice, index) => (
          <div
            key={slice.key}
            title={`${slice.label} · ${formatReserveSharePct(slice.pct)}`}
            className="flex min-w-0 items-center"
            style={{
              flex: `${slice.pct} 1 0%`,
              backgroundColor: RISK_COLORS[slice.risk],
              boxShadow: `inset 0 0 0 1px ${RISK_ACCENT_COLORS[slice.risk]}80`,
            }}
          >
            {index === 0 ? (
              <span className="min-w-0 px-3 py-2 text-xs font-semibold leading-snug" style={{ color: RESERVE_TREEMAP_LABEL_COLOR }}>
                {slice.label}
                <span className="font-mono tabular-nums"> · {formatReserveSharePct(slice.pct)}</span>
              </span>
            ) : null}
          </div>
        ))}
        {unreviewedPct > 0 ? (
          <div
            title={`Unreviewed remainder · ${formatReserveSharePct(unreviewedPct)}`}
            className="min-w-0 border border-dashed border-muted-foreground/50"
            style={{ flex: `${unreviewedPct} 1 0%` }}
          />
        ) : null}
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
      {unreviewedPct > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Unreviewed remainder · <span className="font-mono tabular-nums">{formatReserveSharePct(unreviewedPct)}</span>
        </p>
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
  const isWhole = slice.pct >= 100;
  const ink = isWhole ? RESERVE_TREEMAP_LABEL_COLOR : "var(--color-foreground)";
  const label = (
    <>
      <span className="min-w-0 text-xs font-semibold leading-snug" style={{ color: ink }}>{slice.label}</span>
      <span className="shrink-0 font-mono text-2xs font-semibold tabular-nums" style={{ color: ink }}>{formatReserveSharePct(slice.pct)}</span>
    </>
  );
  return (
    <div className="min-w-0">
      <div className="flex min-h-9 w-full overflow-hidden rounded-md">
        <div
          className="min-w-0"
          style={{
            width: isWhole ? "100%" : `${slice.pct}%`,
            flexShrink: 0,
            backgroundColor: RISK_COLORS[slice.risk],
            boxShadow: `inset 0 0 0 1px ${RISK_ACCENT_COLORS[slice.risk]}80`,
          }}
        >
          {isWhole ? <div className="flex items-center justify-between gap-3 px-3 py-1.5">{label}</div> : null}
        </div>
        {isWhole ? null : (
          <div
            title="Not covered by the reviewed composition"
            className="min-w-0 flex-1 rounded-md border border-dashed border-muted-foreground/50"
          />
        )}
      </div>
      {isWhole ? null : (
        <div className="mt-2 flex min-w-0 items-start justify-between gap-3">{label}</div>
      )}
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
export function ReserveTreemap({ slices, subject, labelLimit = Infinity }: ReserveTreemapProps) {
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
  const totalPct = data.reduce((sum, slice) => sum + slice.pct, 0);
  // Summing authored decimal shares can leave machine-roundoff dust below 100%.
  const remainderPct = 100 - totalPct;
  const unreviewedPct = remainderPct > Number.EPSILON * 100 * data.length ? remainderPct : 0;
  const remainderLabel = unreviewedPct > 0 ? `, Unreviewed remainder ${formatReserveSharePct(unreviewedPct)}` : "";

  if (data.length === 1) {
    const role = top.role ? `, ${top.role}` : "";
    return (
      <div
        role="figure"
        aria-label={`${subject}: ${top.label} ${formatReserveSharePct(top.pct)}, ${RESERVE_RISK_PRESENTATION[top.risk].longLabel}${role}${remainderLabel}`}
        className="min-w-0"
      >
        <SingleSliceBar slice={top} />
      </div>
    );
  }

  const ariaLabel = `${subject}: ${data.map((slice) => `${slice.label} ${formatReserveSharePct(slice.pct)}`).join(", ")}${remainderLabel}`;
  const isDominated = top.pct >= DOMINANT_SLICE_MIN_PCT;

  return (
    <div className="min-w-0">
      {isDominated ? (
        <div role="figure" aria-label={ariaLabel}>
          <DominantSliceBar slices={data} unreviewedPct={unreviewedPct} labelLimit={labelLimit} />
        </div>
      ) : (
        <div className="h-64 w-full min-w-0 overflow-hidden sm:h-72">
          <div ref={chartViewportRef} className="h-full min-w-0 overflow-hidden" role="figure" aria-label={ariaLabel}>
            {chartNear ? <ReserveTreemapChart data={data} unreviewedPct={unreviewedPct} labelLimit={labelLimit} /> : <ChartSkeleton className="h-full w-full" />}
          </div>
        </div>
      )}
      <RiskLegend risks={presentRisks} />
    </div>
  );
}
