"use client";

import { useMemo } from "react";
import { Treemap, Tooltip } from "recharts";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import { RISK_ACCENT_COLORS, RISK_COLORS } from "@/lib/chart-colors";
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

function TreemapCell({ x, y, width, height, name, risk, pct, depth }: TreemapCellProps) {
  // Recharts renders the synthetic root node (depth=0) via content too — skip it
  if (depth === 0) return <g />;

  const fill = RISK_COLORS[risk];
  const showLabel = width > 50 && height > 30;
  const showPct = showLabel && width > 40 && height > 40;

  const maxChars = Math.max(3, Math.floor(width / 7));
  const lines = showLabel ? wrapTreemapLabel(name, maxChars, height > 56 ? 2 : 1) : [];
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
          fill="#fafafa"
          fontSize={Math.min(11, width / 9)}
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
          fill={RISK_ACCENT_COLORS[risk]}
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

export function ReserveTreemap({ reserves, badge }: ReserveTreemapProps) {
  const data = useMemo(
    () => reserves.filter((r) => Number.isFinite(r.pct) && r.pct > 0).map((r) => ({ ...r, size: r.pct })),
    [reserves],
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
      <div className="mt-3 min-h-[200px] min-w-0 flex-1 overflow-hidden">
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
      {/* Risk-tier legend beneath the map (Figma coin template): square
          swatches + mono uppercase labels, centered. */}
      <div className="mt-2.5 flex min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1">
        {(Object.entries(RISK_LABELS) as [ReserveRisk, string][]).map(([risk, label]) => (
          <div key={risk} className="flex min-w-0 items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-[2px]" style={{ backgroundColor: RISK_ACCENT_COLORS[risk] }} />
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
