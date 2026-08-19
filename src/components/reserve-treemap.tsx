"use client";

import { useMemo } from "react";
import { Treemap, Tooltip } from "recharts";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import {
  RESERVE_TREEMAP_INVERSE_LABEL_COLOR,
  RESERVE_TREEMAP_LABEL_COLOR,
  RISK_ACCENT_COLORS,
  RISK_COLORS,
} from "@/lib/chart-colors";
import type { ReserveDisplayBadgeView, ReserveSlice, ReserveRisk } from "@shared/types";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";

interface ReserveTreemapProps {
  reserves: ReserveSlice[];
  badge?: ReserveDisplayBadgeView;
}

const RESERVE_BADGE_CLASSNAMES: Record<ReserveDisplayBadgeView["kind"], string> = {
  live: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/20",
  "curated-validated": "bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-1 ring-inset ring-sky-500/20",
  proof: "bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-1 ring-inset ring-violet-500/20",
};

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
  name: string;
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

function TreemapCell({ x, y, width, height, name, risk, pct, depth }: TreemapCellProps) {
  // Recharts renders the synthetic root node (depth=0) via content too — skip it
  if (depth === 0) return <g />;

  const fill = RISK_COLORS[risk];
  // White on the dark end of the ramp, dark ink on the bright medium tier. The
  // ramp hue itself (red on maroon) does not clear 4.5:1 against its own fill.
  const labelFill = risk === "medium" ? RESERVE_TREEMAP_LABEL_COLOR : RESERVE_TREEMAP_INVERSE_LABEL_COLOR;
  const fontSize = Math.min(11, Math.max(9, width / 9));
  const maxChars = Math.floor((width - LABEL_INSET * 2) / (fontSize * CHAR_WIDTH_EM));
  const showLabel =
    width >= MIN_LABEL_WIDTH &&
    height >= MIN_LABEL_HEIGHT &&
    width * height >= MIN_LABEL_AREA &&
    maxChars >= MIN_LABEL_CHARS;
  const showPct = showLabel && height >= 48;

  const maxLines = height >= 88 ? 3 : height >= 60 ? 2 : 1;
  const lines = showLabel ? wrapTreemapLabel(name, maxChars, maxLines) : [];
  const rowHeight = 13;
  const totalRows = lines.length + (showPct ? 1 : 0);
  const topY = y + height / 2 - ((totalRows - 1) * rowHeight) / 2;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={fill} stroke="var(--color-card)" strokeWidth={2} />
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
          {pct}%
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
  payload?: Array<{ payload: { name: string; pct: number; risk: ReserveRisk } }>;
}) {
  if (!payload?.[0]) return null;
  const { name, pct, risk } = payload[0].payload;
  return (
    <PharosChartTooltip active={active}>
      <TooltipLabel>{name}</TooltipLabel>
      <TooltipRow color={RISK_ACCENT_COLORS[risk]} label={RESERVE_RISK_PRESENTATION[risk].longLabel} value={`${pct}%`} />
    </PharosChartTooltip>
  );
}

export function ReserveTreemap({ reserves, badge }: ReserveTreemapProps) {
  const data = useMemo(
    () => reserves.filter((r) => Number.isFinite(r.pct) && r.pct > 0).map((r) => ({ ...r, size: r.pct })),
    [reserves],
  );
  // Only the tiers actually in the basket are keyed; a fixed five-tier row
  // would describe colors that appear nowhere on the chart.
  const presentRisks = useMemo(
    () => (Object.keys(RESERVE_RISK_PRESENTATION) as ReserveRisk[]).filter((risk) => data.some((r) => r.risk === risk)),
    [data],
  );
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  // Rendered flat (no Card chrome): the treemap lives inside the report-card
  // panel's right column, and a nested card would violate Flat-By-Default.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <DetailSectionTitle className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold tracking-normal text-muted-foreground">
          Reserve Composition
          {badge && (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${RESERVE_BADGE_CLASSNAMES[badge.kind]}`}
            >
              {badge.label}
            </span>
          )}
        </DetailSectionTitle>
        {/* Risk-tier legend on the title row (right-aligned to save vertical
            space): square swatches + mono uppercase labels. Shown even for a
            single-tier basket so the color always has a key. */}
        {presentRisks.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
            {presentRisks.map((risk) => (
              <div key={risk} className="flex min-w-0 items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-[2px]" style={{ backgroundColor: RISK_ACCENT_COLORS[risk] }} />
                <span className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {RESERVE_RISK_PRESENTATION[risk].longLabel}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Below lg the panel stacks in auto-height flow, so the stage keeps its
          6/5 ratio (flex-1 would collapse to zero with no definite parent
          height). At lg the report-card grid gives the right column a definite
          height driven by the score column, so the stage flexes into whatever
          that is instead of overflowing a width-derived ratio and clipping the
          bottom row of tiles. The ratio lives in a class, not an inline style,
          so the lg override can win. */}
      <div className="mt-3 aspect-[6/5] min-h-[200px] w-full min-w-0 shrink-0 overflow-hidden lg:aspect-auto lg:min-h-[240px] lg:max-h-[520px] lg:flex-1 lg:shrink">
        <div
          ref={chartContainerRef}
          className="h-full min-w-0 overflow-hidden"
          role="figure"
          aria-label={`Reserve composition treemap: ${reserves.map((r) => `${r.name} ${r.pct}%`).join(", ")}`}
        >
          {isChartReady ? (
            <SectionErrorBoundary name="reserve-treemap" supportingText="Reserve composition chart unavailable">
              <Treemap
                width={width}
                height={height}
                data={data}
                dataKey="size"
                nameKey="name"
                content={(props) => <TreemapCell {...(props as unknown as TreemapCellProps)} />}
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
    </div>
  );
}
