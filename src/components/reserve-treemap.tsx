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

interface ReserveTreemapProps {
  reserves: ReserveSlice[];
  badge?: ReserveDisplayBadgeView;
}

const RISK_LABELS: Record<ReserveRisk, string> = {
  "very-low": "Very Low Risk",
  low: "Low Risk",
  medium: "Medium Risk",
  high: "High Risk",
  "very-high": "Very High Risk",
};

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
      <TooltipRow color={RISK_ACCENT_COLORS[risk]} label={RISK_LABELS[risk]} value={`${pct}%`} />
    </PharosChartTooltip>
  );
}

/* One or two slices do not need a treemap: a 100% block half a screen tall
 * states one fact. The compact bar carries the same fills with the labels beside
 * them, so nothing moves into a tooltip. */
function CompactComposition({ data }: { data: Array<{ name: string; pct: number; risk: ReserveRisk }> }) {
  return (
    <div className="mt-3 min-w-0">
      <div
        className="flex h-8 w-full overflow-hidden rounded-md"
        role="figure"
        aria-label={`Reserve composition: ${data.map((r) => `${r.name} ${r.pct}%`).join(", ")}`}
      >
        {data.map((r) => (
          <div
            key={r.name}
            className="h-full"
            style={{ width: `${r.pct}%`, minWidth: "4px", backgroundColor: RISK_COLORS[r.risk] }}
          />
        ))}
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {data.map((r) => (
          <li key={r.name} className="flex items-center gap-2">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: RISK_ACCENT_COLORS[r.risk] }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 font-mono text-[11px] uppercase leading-tight tracking-[0.08em] text-foreground">
              {r.name}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{r.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Below this slice count the treemap degenerates, so the compact bar takes over. */
const TREEMAP_MIN_SLICES = 3;

export function ReserveTreemap({ reserves, badge }: ReserveTreemapProps) {
  const data = useMemo(
    () => reserves.filter((r) => Number.isFinite(r.pct) && r.pct > 0).map((r) => ({ ...r, size: r.pct })),
    [reserves],
  );
  const isCompact = data.length > 0 && data.length < TREEMAP_MIN_SLICES;
  // Only the tiers actually in the basket are keyed; a single-tier basket needs
  // no key at all, and a fixed five-tier row would describe colors that appear
  // nowhere on the chart.
  const presentRisks = useMemo(
    () => (Object.keys(RISK_LABELS) as ReserveRisk[]).filter((risk) => data.some((r) => r.risk === risk)),
    [data],
  );
  const { ref: chartContainerRef, ready: isChartReady, width, height } = useChartContainerReady<HTMLDivElement>();

  // Rendered flat (no Card chrome): the treemap lives inside the report-card
  // panel's right column, and a nested card would violate Flat-By-Default.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-w-0">
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
      </div>
      {isCompact ? (
        <CompactComposition data={data} />
      ) : (
        <div
          className="mt-3 min-h-[200px] w-full min-w-0 shrink-0 overflow-hidden lg:max-h-[520px]"
          style={{ aspectRatio: "6 / 5" }}
        >
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
      )}
      {/* Risk-tier legend beneath the map (Figma coin template): square
          swatches + mono uppercase labels, left-aligned so it holds the same
          position from coin to coin. */}
      {presentRisks.length > 1 && (
        <div className="mt-2.5 flex min-w-0 flex-wrap items-center justify-start gap-x-3 gap-y-1">
          {presentRisks.map((risk) => (
            <div key={risk} className="flex min-w-0 items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-[2px]" style={{ backgroundColor: RISK_ACCENT_COLORS[risk] }} />
              <span className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {RISK_LABELS[risk]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
