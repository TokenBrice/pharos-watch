"use client";

import { Treemap, Tooltip } from "recharts";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { ChartSkeleton } from "@/components/chart-skeleton";
import { useChartContainerReady } from "@/hooks/use-chart-container-ready";
import { PharosChartTooltip, TooltipLabel, TooltipRow } from "@/components/pharos-chart-tooltip";
import type { ReserveCompositionSlice } from "@/components/stablecoin-detail/reserve-presentation";
import { RESERVE_TREEMAP_LABEL_COLOR, RISK_ACCENT_COLORS, RISK_COLORS } from "@/lib/chart-colors";
import type { ReserveRisk } from "@shared/types";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";
import { formatReserveSharePct } from "@/components/reserve-risk-swatch";

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
 * stays reachable by tooltip, which beats a word cut in half. Names are set in
 * the sans face as written (mono caps is for figures only); `CHAR_WIDTH_EM`
 * is a generous mixed-case semibold advance, so the estimate errs toward
 * wrapping instead of overflowing the tile. */
const LABEL_INSET = 6;
const CHAR_WIDTH_EM = 0.6;
const MIN_LABEL_WIDTH = 68;
const MIN_LABEL_HEIGHT = 32;
const MIN_LABEL_AREA = 3400;
const MIN_LABEL_CHARS = 6;

function TreemapCell({ x, y, width, height, label, risk, pct, depth }: TreemapCellProps) {
  // Recharts renders the synthetic root node (depth=0) via content too — skip it
  if (depth === 0) return <g />;

  const fill = RISK_COLORS[risk];
  const labelFill = RESERVE_TREEMAP_LABEL_COLOR;
  // 11 px floor: smaller tiles wrap or drop the label (tooltip) rather than shrink it.
  const fontSize = 11;
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
  const rowHeight = 14;
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
          fontFamily="var(--font-sans, sans-serif)"
        >
          {lines.map((line, i) => (
            <tspan key={i} x={x + width / 2} y={topY + i * rowHeight}>
              {line}
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
          fontSize={11}
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

export function ReserveTreemapChart({ data }: { data: readonly ReserveCompositionSlice[] }) {
  const { ref, ready, width, height } = useChartContainerReady<HTMLDivElement>();

  return (
    <div ref={ref} className="h-full min-w-0 overflow-hidden">
      {ready ? (
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
  );
}
