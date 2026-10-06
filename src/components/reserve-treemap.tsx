"use client";

import { useMemo } from "react";
import { Treemap, Tooltip } from "recharts";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import type { ReserveCompositionSlice } from "@/components/stablecoin-detail/reserve-presentation";
import {
  RESERVE_TREEMAP_INVERSE_LABEL_COLOR,
  RESERVE_TREEMAP_LABEL_COLOR,
  RISK_ACCENT_COLORS,
  RISK_COLORS,
} from "@/lib/chart-colors";
import type { ReserveRisk } from "@shared/types";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";
import { formatDecimal } from "@shared/lib/format";

interface ReserveTreemapProps {
  slices: readonly ReserveCompositionSlice[];
  /** What the figure shows, for its accessible name: "Reviewed reserve slices". */
  subject: string;
}

/**
 * A basket whose largest slice holds at least this share is drawn as a single
 * labelled bar: a treemap of one tile (LUSD 100% ETH) or a 92% tile plus
 * crumbs is a giant rectangle that encodes nothing a bar does not.
 */
const DOMINANT_SLICE_MIN_PCT = 90;

/* Break a cell label on word boundaries instead of mid-word ("Deposits at
 * Sy…"). Lines hold whole words up to maxChars; running out of lines appends
 * an ellipsis after the last whole word. Only a single word longer than the
 * cell still gets a hard cut. */
function wrapTreemapLabel(name: string, maxChars: number, maxLines: number): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || current === "") {
      current = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      return [...lines, `${current}…`];
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines.map((line) =>
    line.length > maxChars ? `${line.slice(0, Math.max(2, maxChars - 1)).trimEnd()}…` : line,
  );
}

interface TreemapCellProps {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  risk: ReserveRisk;
  pct: number;
  depth?: number;
}

/* Label geometry. Text is inset from the tile edge rather than run to it, and a
 * tile too small to hold a legible line drops its label entirely — the slice
 * stays reachable by tooltip, which beats a word cut in half. `CHAR_WIDTH_EM`
 * is the mono advance (0.6em) plus the 0.06em tracking below, rounded up so the
 * estimate errs toward wrapping instead of overflowing the tile. */
const LABEL_INSET = 6;
const CHAR_WIDTH_EM = 0.68;
const MIN_LABEL_WIDTH = 68;
const MIN_LABEL_HEIGHT = 32;
const MIN_LABEL_AREA = 3400;
const MIN_LABEL_CHARS = 6;

/** Reserve shares are display-rounded to two decimals; positive dust stays visible. */
function formatReserveSharePct(pct: number): string {
  return pct > 0 && pct < 0.01 ? "<0.01%" : `${formatDecimal(pct, 0, 2)}%`;
}

/** White on the dark end of the ramp, dark ink on the bright medium tier. The
 *  ramp hue itself (red on maroon) does not clear 4.5:1 against its own fill. */
function labelInk(risk: ReserveRisk): string {
  return risk === "medium" ? RESERVE_TREEMAP_LABEL_COLOR : RESERVE_TREEMAP_INVERSE_LABEL_COLOR;
}

function TreemapCell({ x, y, width, height, label, risk, pct, depth }: TreemapCellProps) {
  // Recharts renders the synthetic root node (depth=0) via content too — skip it
  if (depth === 0) return <g />;

  const fill = RISK_COLORS[risk];
  const labelFill = labelInk(risk);
  const fontSize = Math.min(11, Math.max(9, width / 9));
  const maxChars = Math.floor((width - LABEL_INSET * 2) / (fontSize * CHAR_WIDTH_EM));
  const showLabel =
    width >= MIN_LABEL_WIDTH &&
    height >= MIN_LABEL_HEIGHT &&
    width * height >= MIN_LABEL_AREA &&
    maxChars >= MIN_LABEL_CHARS;
  const showPct = showLabel && height >= 48;

  const maxLines = height >= 88 ? 3 : height >= 60 ? 2 : 1;
  let lines = showLabel ? wrapTreemapLabel(label, maxChars, maxLines) : [];
  // A parenthetical expansion ("XAUt (Tether Gold)") is the first thing to give
  // up: the bare name beats a sentence cut off mid-word.
  if (lines.at(-1)?.endsWith("…") && label.includes("(")) {
    const bareLines = wrapTreemapLabel(label.replace(/\s*\(.*\)\s*$/, ""), maxChars, maxLines);
    if (!bareLines.at(-1)?.endsWith("…")) lines = bareLines;
  }
  const rowHeight = 13;
  const totalRows = lines.length + (showPct ? 1 : 0);
  const topY = y + height / 2 - ((totalRows - 1) * rowHeight) / 2;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={fill} stroke="var(--color-card)" strokeWidth={2} />
      {/* The tier's accent as an inset outline: the legend swatch carries the same
          fill + accent border, so a tile always has a swatch it visibly matches. */}
      {width > 8 && height > 8 && (
        <rect
          x={x + 1.5}
          y={y + 1.5}
          width={width - 3}
          height={height - 3}
          rx={3}
          fill="none"
          stroke={RISK_ACCENT_COLORS[risk]}
          strokeOpacity={0.5}
          strokeWidth={1}
        />
      )}
      {showLabel && (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fill={labelFill}
          fontSize={fontSize}
          fontWeight={600}
          fontFamily="var(--font-mono, monospace)"
          letterSpacing="0.06em"
        >
          {lines.map((line, i) => (
            <tspan key={i} x={x + width / 2} y={topY + i * rowHeight}>
              {line.toUpperCase()}
            </tspan>
          ))}
        </text>
      )}
      {showLabel && showPct && (
        <text
          x={x + width / 2}
          y={topY + lines.length * rowHeight}
          textAnchor="middle"
          dominantBaseline="central"
          fill={labelFill}
          fillOpacity={0.8}
          fontSize={10}
          fontWeight={600}
          fontFamily="var(--font-mono, monospace)"
        >
          {formatReserveSharePct(pct)}
        </text>
      )}
    </g>
  );
}

function ReserveTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ReserveCompositionSlice }>;
}) {
  if (!payload?.[0]) return null;
  const { label, pct, risk, detail } = payload[0].payload;
  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{label}</TooltipLabel>
      <TooltipRow color={RISK_ACCENT_COLORS[risk]} label={RESERVE_RISK_PRESENTATION[risk].longLabel} value={formatReserveSharePct(pct)} />
      {detail ? <div className="mt-1 max-w-56 text-xs text-muted-foreground">{detail}</div> : null}
    </PharosChartTooltip>
  );
}

/** A risk-tier swatch is the tile itself in miniature: same fill, same accent border. */
function RiskSwatch({ risk }: { risk: ReserveRisk }) {
  return (
    <span
      className="size-2.5 shrink-0 rounded-[2px] border"
      style={{ backgroundColor: RISK_COLORS[risk], borderColor: RISK_ACCENT_COLORS[risk] }}
    />
  );
}

/** Only the tiers actually drawn are keyed; every tile tone has a swatch. */
function RiskLegend({ risks }: { risks: readonly ReserveRisk[] }) {
  return (
    <ul aria-label="Reserve risk tiers" className="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      {risks.map((risk) => (
        <li key={risk} className="flex min-w-0 items-center gap-1.5">
          <RiskSwatch risk={risk} />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {RESERVE_RISK_PRESENTATION[risk].longLabel}
          </span>
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
              <span
                className="min-w-0 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.06em]"
                style={{ color: labelInk(slice.risk) }}
              >
                {slice.label} · {formatReserveSharePct(slice.pct)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {rest.length > 0 ? (
        <ul aria-label="Other reserve slices" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {rest.map((slice) => (
            <li key={slice.key} className="flex items-center gap-1.5">
              <RiskSwatch risk={slice.risk} />
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
 * The module's one reserve visual, toned by risk tier. Renders flat (no card
 * chrome; the Reserves module owns the shell). Dominated baskets draw as a bar
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
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  if (data.length === 0) return null;

  const ariaLabel = `${subject}: ${data.map((slice) => `${slice.label} ${formatReserveSharePct(slice.pct)}`).join(", ")}`;
  const isDominated = data[0]!.pct >= DOMINANT_SLICE_MIN_PCT;

  return (
    <div className="min-w-0">
      {isDominated ? (
        <div role="figure" aria-label={ariaLabel}>
          <DominantSliceBar slices={data} />
        </div>
      ) : (
        <div className="h-64 w-full min-w-0 overflow-hidden sm:h-72">
          <div ref={chartContainerRef} className="h-full min-w-0 overflow-hidden" role="figure" aria-label={ariaLabel}>
            {isChartReady ? (
              <SectionErrorBoundary name="reserve-treemap" supportingText="Reserve composition chart unavailable">
                <Treemap
                  width={width}
                  height={height}
                  data={data.map((slice) => ({ ...slice, size: slice.pct }))}
                  dataKey="size"
                  nameKey="label"
                  content={(props) => {
                    // Recharts passes `key` inside the props bag; React rejects keys spread into JSX.
                    const { key: _key, ...cell } = props as unknown as TreemapCellProps & { key?: unknown };
                    return <TreemapCell {...cell} />;
                  }}
                  isAnimationActive={false}
                >
                  <Tooltip content={<ReserveTooltip />} />
                </Treemap>
              </SectionErrorBoundary>
            ) : (
              <ChartSkeleton className="h-full w-full" />
            )}
          </div>
        </div>
      )}
      <RiskLegend risks={presentRisks} />
    </div>
  );
}
