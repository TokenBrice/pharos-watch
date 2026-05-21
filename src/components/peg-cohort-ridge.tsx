"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PegSummaryCoin } from "@shared/types";

/* Compact ridge plot of current cohort peg-deviation distribution
   (Council D15, IDEA-7).
   One ridge per peg-currency cohort. Thin KDE band over ±200 bps,
   anchored to the 0-bps hairline. Cohort median dot annotated.
   Cohorts with < MIN_COHORT_SIZE fall back to a strip of dots.

   Note on data window: we use the *current* snapshot of
   `currentDeviationBps` across coins per cohort, not a 30d aggregate
   (no such endpoint exists, and per-coin 30d fetches across hundreds
   of coins would be prohibitive). The cohort-shape comparison story
   still holds — which cohorts run wider, where the tails sit. */

interface PegCohortRidgeProps {
  coins: PegSummaryCoin[];
}

const DOMAIN_BPS = 200;
const MIN_COHORT_SIZE = 6;
const RIDGE_HEIGHT = 28;
const ROW_GAP = 4;
const SAMPLE_POINTS = 81; // ±200 bps in 5 bps steps
const PAD_LEFT = 76;
const PAD_RIGHT = 32;
const SVG_VIEW_WIDTH = 800;

interface CohortDef {
  key: "USD" | "EUR" | "GBP" | "GOLD" | "OTHER";
  label: string;
  membersOf: (peg: string) => boolean;
}

const COHORTS: CohortDef[] = [
  { key: "USD", label: "USD", membersOf: (peg) => peg === "USD" },
  { key: "EUR", label: "EUR", membersOf: (peg) => peg === "EUR" },
  { key: "GBP", label: "GBP", membersOf: (peg) => peg === "GBP" },
  { key: "GOLD", label: "Gold", membersOf: (peg) => peg === "GOLD" || peg === "SILVER" },
  {
    key: "OTHER",
    label: "Other Fiat",
    membersOf: (peg) =>
      peg !== "USD" && peg !== "EUR" && peg !== "GBP" && peg !== "GOLD" && peg !== "SILVER",
  },
];

const COHORT_COLOR: Record<CohortDef["key"], string> = {
  USD: "#22c55e",
  EUR: "#8b5cf6",
  GBP: "#06b6d4",
  GOLD: "#f59e0b",
  OTHER: "#94a3b8",
};

function bpsToX(bps: number, plotWidth: number): number {
  const clamped = Math.max(-DOMAIN_BPS, Math.min(DOMAIN_BPS, bps));
  return PAD_LEFT + ((clamped + DOMAIN_BPS) / (DOMAIN_BPS * 2)) * plotWidth;
}

/** Population std-dev (cohort, not sample). */
function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Gaussian kernel value at standardized distance. */
function gaussian(u: number): number {
  return Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
}

interface KDESeries {
  /** Each point: [x in bps, density]. Density is normalized so max = 1. */
  points: Array<[number, number]>;
}

function buildKDE(values: number[], bandwidth: number): KDESeries {
  if (values.length === 0 || bandwidth <= 0) return { points: [] };
  const step = (DOMAIN_BPS * 2) / (SAMPLE_POINTS - 1);
  const raw: Array<[number, number]> = [];
  let maxDensity = 0;
  for (let i = 0; i < SAMPLE_POINTS; i += 1) {
    const x = -DOMAIN_BPS + i * step;
    let sum = 0;
    for (const v of values) {
      sum += gaussian((x - v) / bandwidth);
    }
    const density = sum / (values.length * bandwidth);
    raw.push([x, density]);
    if (density > maxDensity) maxDensity = density;
  }
  // Normalize so peak = 1 for plotting convenience.
  const points = raw.map(
    ([x, d]): [number, number] => [x, maxDensity > 0 ? d / maxDensity : 0],
  );
  return { points };
}

/** Silverman's rule-of-thumb bandwidth. */
function silvermanBandwidth(values: number[]): number {
  const n = values.length;
  if (n < 2) return 25; // sensible floor
  const sd = stddev(values);
  // Guard against zero-variance cohorts (all values identical).
  if (sd === 0) return 25;
  return 1.06 * sd * Math.pow(n, -1 / 5);
}

interface CohortData {
  key: CohortDef["key"];
  label: string;
  values: number[];
  median: number;
  kde: KDESeries | null;
  fallbackToStrip: boolean;
}

function buildCohortData(coins: Array<PegSummaryCoin & { currentDeviationBps: number }>): CohortData[] {
  return COHORTS.map((cohort) => {
    const values = coins
      .filter((c) => cohort.membersOf(c.pegCurrency))
      .map((c) => c.currentDeviationBps);
    if (values.length === 0) {
      return {
        key: cohort.key,
        label: cohort.label,
        values,
        median: 0,
        kde: null,
        fallbackToStrip: false,
      };
    }
    if (values.length < MIN_COHORT_SIZE) {
      return {
        key: cohort.key,
        label: cohort.label,
        values,
        median: median(values),
        kde: null,
        fallbackToStrip: true,
      };
    }
    const bw = silvermanBandwidth(values);
    return {
      key: cohort.key,
      label: cohort.label,
      values,
      median: median(values),
      kde: buildKDE(values, bw),
      fallbackToStrip: false,
    };
  }).filter((row) => row.values.length > 0);
}

function buildRidgePath(kde: KDESeries, plotWidth: number, baselineY: number, amplitude: number): string {
  if (kde.points.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < kde.points.length; i += 1) {
    const [bps, d] = kde.points[i];
    const x = bpsToX(bps, plotWidth);
    const y = baselineY - d * amplitude;
    parts.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  // Close path to baseline.
  const lastX = bpsToX(kde.points[kde.points.length - 1][0], plotWidth);
  const firstX = bpsToX(kde.points[0][0], plotWidth);
  parts.push(`L ${lastX.toFixed(2)} ${baselineY.toFixed(2)}`);
  parts.push(`L ${firstX.toFixed(2)} ${baselineY.toFixed(2)}`);
  parts.push("Z");
  return parts.join(" ");
}

function formatSignedBps(bps: number): string {
  const rounded = Math.round(bps);
  if (rounded > 0) return `+${rounded}`;
  return `${rounded}`;
}

export function PegCohortRidge({ coins }: PegCohortRidgeProps) {
  const cohortData = useMemo(() => {
    const filtered = coins.filter(
      (c): c is PegSummaryCoin & { currentDeviationBps: number } => c.currentDeviationBps !== null,
    );
    return buildCohortData(filtered);
  }, [coins]);

  if (cohortData.length === 0) {
    return null;
  }

  const plotWidth = SVG_VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
  const totalHeight = cohortData.length * (RIDGE_HEIGHT + ROW_GAP) + 18; // +18 for axis labels

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <CardTitle as="h2" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Cohort Deviation Shape
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Current distribution of peg deviations per cohort, clamped to &plusmn;200 bps. Cohort median marked.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <svg
          viewBox={`0 0 ${SVG_VIEW_WIDTH} ${totalHeight}`}
          preserveAspectRatio="none"
          width="100%"
          height={totalHeight}
          role="img"
          aria-label="Ridge plot of peg-deviation distribution by cohort"
          className="block overflow-visible"
        >
          {/* Axis labels */}
          <g className="font-mono text-[9px] fill-muted-foreground">
            {[-200, -100, 0, 100, 200].map((bps) => (
              <text
                key={bps}
                x={bpsToX(bps, plotWidth)}
                y={10}
                textAnchor="middle"
                fill="currentColor"
              >
                {bps === 0 ? "0" : formatSignedBps(bps)}
              </text>
            ))}
          </g>

          {/* Vertical peg-line hairline running through every ridge */}
          <line
            x1={bpsToX(0, plotWidth)}
            x2={bpsToX(0, plotWidth)}
            y1={14}
            y2={totalHeight}
            stroke="currentColor"
            strokeWidth={0.75}
            className="text-muted-foreground/40"
          />

          {cohortData.map((row, i) => {
            const baselineY = 18 + (i + 1) * (RIDGE_HEIGHT + ROW_GAP) - ROW_GAP;
            const amplitude = RIDGE_HEIGHT - 4;
            const color = COHORT_COLOR[row.key];

            return (
              <g key={row.key}>
                  {/* Baseline */}
                <line
                  x1={PAD_LEFT}
                  x2={PAD_LEFT + plotWidth}
                  y1={baselineY}
                  y2={baselineY}
                  stroke="currentColor"
                  strokeWidth={0.5}
                  className="text-border"
                />

                {/* Cohort label */}
                <text
                  x={PAD_LEFT - 8}
                  y={baselineY - 2}
                  textAnchor="end"
                  fill="currentColor"
                  className="text-[10px] font-medium uppercase tracking-wider fill-muted-foreground"
                >
                  {row.label}
                </text>
                <text
                  x={PAD_LEFT - 8}
                  y={baselineY + 9}
                  textAnchor="end"
                  fill="currentColor"
                  className="font-mono text-[9px] fill-muted-foreground/60"
                >
                  n={row.values.length}
                </text>

                {row.kde ? (
                  <path
                    d={buildRidgePath(row.kde, plotWidth, baselineY, amplitude)}
                    fill={color}
                    fillOpacity={0.18}
                    stroke={color}
                    strokeWidth={1}
                  />
                ) : (
                  // Strip-plot fallback for thin cohorts
                  row.values.map((v, idx) => (
                    <circle
                      key={`${row.key}-strip-${idx}`}
                      cx={bpsToX(v, plotWidth)}
                      cy={baselineY - 8}
                      r={3}
                      fill={color}
                      fillOpacity={0.7}
                      stroke={color}
                      strokeWidth={0.5}
                    />
                  ))
                )}

                {/* Median annotation dot */}
                <circle
                  cx={bpsToX(row.median, plotWidth)}
                  cy={baselineY}
                  r={2.5}
                  fill={color}
                  stroke="var(--color-background, #0a0a0a)"
                  strokeWidth={1}
                />

                {/* Median label, offset just above baseline */}
                <text
                  x={bpsToX(row.median, plotWidth) + 6}
                  y={baselineY - 4}
                  fill={color}
                  className="font-mono text-[9px]"
                >
                  med {formatSignedBps(row.median)}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Density estimated with a fixed Silverman bandwidth on the current snapshot. Cohorts with fewer than {MIN_COHORT_SIZE} coins render as a strip of dots.
        </p>
      </CardContent>
    </Card>
  );
}
