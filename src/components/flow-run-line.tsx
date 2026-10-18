"use client";

import { ChartDataTable, type ChartDataTableColumn } from "@/components/chart-primitives/data-table";
import { GAUGE_BAND_LABELS, GAUGE_BAND_TONE_CLASSES } from "@shared/lib/classification";
import { formatCurrency } from "@shared/lib/format";
import { GAUGE_BAND_RANGES } from "@shared/lib/mint-burn-gauge-bands";
import { formatBankRunGaugeScore } from "@shared/lib/mint-burn-signals";
import {
  RUN_LINE_EXCLUSION_LABELS,
  selectRunLineDrivers,
  type RunLineModel,
  type RunLineStub,
  type RunLineTick,
} from "@/lib/flow-run-line-model";
import { cn } from "@/lib/utils";

/**
 * The /flows/ signature: a weighted pressure strip. x is each coin's pressure
 * shift (-100..+100) over the published band zones; tick height is its gauge
 * weight (square-root scale with a floor); the ink rule is the gauge itself.
 * Coins outside the score stand as dashed stubs in a counted side gutter. Every
 * mark is a data field; the sr-only table carries the same facts.
 *
 * Marks live in a stretched SVG (`preserveAspectRatio="none"`, non-scaling
 * strokes) so x maps to percent and heights stay in pixels; text is HTML at the
 * same coordinates, so labels never scale with the viewport.
 */

const WEIGHTED_PLOT_HEIGHT_PX = 190;
/** Without published weights every tick is the same height, so the stage collapses rather than sit empty. */
const UNWEIGHTED_PLOT_HEIGHT_PX = 72;
/** Headroom above the tallest tick for the rule label and driver labels. */
const LABEL_HEADROOM_PX = 26;
const MIN_TICK_PX = 6;
const UNWEIGHTED_TICK_PX = 36;
const MAX_GUTTER_STUBS = 6;
/** Labels closer than this (percent of width) stack instead of overlapping. */
const LABEL_MIN_GAP_PCT = 9;
const LABEL_LINE_PX = 13;

/** Inner band edges, from the shared thresholds (R5): the dashed guides. */
const BAND_EDGES = GAUGE_BAND_RANGES.slice(1).map((range) => range.min);
/** Axis ticks at the scale ends and every band edge; the edge next to each end drops on phones. */
const AXIS_LABELS = [GAUGE_BAND_RANGES[0].min, ...BAND_EDGES, GAUGE_BAND_RANGES[GAUGE_BAND_RANGES.length - 1].max].map(
  (value, index, all) => ({ value, mobile: index !== 1 && index !== all.length - 2 }),
);


function toPct(score: number): number {
  return (score + 100) / 2;
}

function formatAxis(value: number): string {
  return value === 0 ? "0" : formatBankRunGaugeScore(value);
}

function tickHeightPx(weightUsd: number | null, maxWeightUsd: number | null, plotHeightPx: number): number {
  if (weightUsd == null || maxWeightUsd == null || maxWeightUsd <= 0) return UNWEIGHTED_TICK_PX;
  const ratio = Math.min(1, Math.max(0, weightUsd / maxWeightUsd));
  return MIN_TICK_PX + (plotHeightPx - MIN_TICK_PX) * Math.sqrt(ratio);
}

/** Within this distance (percent of width) of the rule, a label hangs away from it. */
const RULE_CLEARANCE_PCT = 6;

interface PlacedLabel {
  id: string;
  symbol: string;
  pct: number;
  bottomPx: number;
  /** `center` over the tick, or hung to one side so the gauge rule never cuts it. */
  anchor: "center" | "left" | "right";
}

/**
 * Greedy stacking: a label near an already placed one moves up a line. Drivers
 * (named in the verdict) are placed first and never dropped: one that would
 * overflow the headroom hangs beside its own tick top instead. Other labels
 * (the extremes) drop when there is no room.
 */
function placeLabels(
  ticks: readonly RunLineTick[],
  driverIds: ReadonlySet<string>,
  maxWeightUsd: number | null,
  rulePct: number | null,
  plotHeightPx: number,
): PlacedLabel[] {
  const placed: Array<PlacedLabel & { level: number }> = [];
  const ordered = [...ticks].sort(
    (a, b) => Number(driverIds.has(b.id)) - Number(driverIds.has(a.id)) || a.score - b.score,
  );
  for (const tick of ordered) {
    const pct = toPct(tick.score);
    const tickTopPx = tickHeightPx(tick.weightUsd, maxWeightUsd, plotHeightPx);
    let level = 0;
    while (placed.some((label) => label.level === level && Math.abs(label.pct - pct) < LABEL_MIN_GAP_PCT)) level += 1;
    const nearRule = rulePct != null && Math.abs(pct - rulePct) < RULE_CLEARANCE_PCT;
    if (tickTopPx + 4 + level * LABEL_LINE_PX + LABEL_LINE_PX > plotHeightPx + LABEL_HEADROOM_PX) {
      if (!driverIds.has(tick.id)) continue;
      const side = rulePct != null && nearRule ? (pct >= rulePct ? "left" : "right") : pct > 50 ? "right" : "left";
      placed.push({ id: tick.id, symbol: tick.symbol, pct, bottomPx: tickTopPx + 4, anchor: side, level: -1 });
      continue;
    }
    // Edge labels hang inward; labels beside the rule hang away from it.
    const anchor = pct < 4 ? "left" : pct > 96 ? "right" : !nearRule ? "center" : pct >= rulePct ? "left" : "right";
    placed.push({ id: tick.id, symbol: tick.symbol, pct, bottomPx: tickTopPx + 4 + level * LABEL_LINE_PX, anchor, level });
  }
  return placed;
}

interface RunLineRow {
  symbol: string;
  pressure: string;
  weight: string;
  pull: string;
  status: string;
}

const RUN_LINE_TABLE_COLUMNS: ChartDataTableColumn<RunLineRow>[] = [
  { id: "coin", label: "Coin", format: (row) => row.symbol },
  { id: "pressure", label: "Pressure vs 30-day norm", format: (row) => row.pressure },
  { id: "weight", label: "Gauge weight (USD)", format: (row) => row.weight },
  { id: "pull", label: "Pull on gauge (points)", format: (row) => row.pull },
  { id: "status", label: "Status", format: (row) => row.status },
];

function buildTableRows(model: RunLineModel): RunLineRow[] {
  const weight = (value: number | null) => (value == null ? "—" : formatCurrency(value, 1));
  return [
    ...model.ticks.map((tick) => ({
      symbol: tick.symbol,
      pressure: formatAxis(Math.round(tick.score)),
      weight: weight(tick.weightUsd),
      pull: tick.pullPoints == null ? "—" : tick.pullPoints.toFixed(1),
      status: "In score",
    })),
    ...model.stubs.map((stub) => ({
      symbol: stub.symbol,
      pressure: "NR",
      weight: weight(stub.weightUsd),
      pull: "—",
      status: RUN_LINE_EXCLUSION_LABELS[stub.reason],
    })),
  ];
}

function describeRunLine(model: RunLineModel): string {
  const outside = `${model.stubs.length} tracked ${model.stubs.length === 1 ? "coin is" : "coins are"} not in the score`;
  if (model.score == null) {
    return `Run line: the Bank Run Gauge is not rated this window; ${outside}.`;
  }
  const first = model.ticks[0];
  const last = model.ticks[model.ticks.length - 1];
  const range = first && last
    ? `, from ${formatAxis(Math.round(first.score))} (${first.symbol}) to ${formatAxis(Math.round(last.score))} (${last.symbol})`
    : "";
  const band = model.band != null ? `${GAUGE_BAND_LABELS[model.band]} band` : "band unsettled by withheld weight";
  return `Run line: ${model.ticks.length} coins in the Bank Run Gauge${range}; gauge ${formatBankRunGaugeScore(model.score)}, ${band}; ${outside}.`;
}

function GutterStubs({
  stubs,
  maxWeightUsd,
  plotHeightPx,
}: {
  stubs: readonly RunLineStub[];
  maxWeightUsd: number | null;
  plotHeightPx: number;
}) {
  const drawn = stubs.filter((stub) => stub.weightUsd == null || stub.weightUsd > 0).slice(0, MAX_GUTTER_STUBS);
  const labelled = drawn[0]?.weightUsd != null ? drawn[0] : null;
  const step = 100 / (MAX_GUTTER_STUBS + 1);
  return (
    <div className="relative" style={{ height: plotHeightPx + LABEL_HEADROOM_PX }}>
      <svg
        className="absolute inset-x-0 bottom-0 w-full text-muted-foreground"
        style={{ height: plotHeightPx }}
        viewBox={`0 0 100 ${plotHeightPx}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {drawn.map((stub, index) => {
          const x = step * (index + 1);
          return (
            <line
              key={stub.id}
              x1={x}
              x2={x}
              y1={plotHeightPx}
              y2={plotHeightPx - tickHeightPx(stub.weightUsd, maxWeightUsd, plotHeightPx)}
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            >
              <title>{`${stub.symbol}: not in score (${RUN_LINE_EXCLUSION_LABELS[stub.reason]})`}</title>
            </line>
          );
        })}
      </svg>
      {labelled ? (
        <span
          className="pharos-numeric absolute -translate-x-1/2 whitespace-nowrap text-3xs text-muted-foreground"
          style={{ left: `${step}%`, bottom: tickHeightPx(labelled.weightUsd, maxWeightUsd, plotHeightPx) + 4 }}
          aria-hidden="true"
        >
          {labelled.symbol}
        </span>
      ) : null}
    </div>
  );
}

export function FlowRunLine({ model, className }: { model: RunLineModel; className?: string }) {
  const { ticks, stubs, maxWeightUsd, score, band } = model;
  const drivers = selectRunLineDrivers(model);
  const driverIds = new Set([...drivers.down, ...drivers.up].map((tick) => tick.id));
  const rulePct = score == null ? null : toPct(score);
  // Drivers carry the verdict; the two extremes bound the spread.
  const labelIds = new Set([...driverIds, ticks[0]?.id, ticks[ticks.length - 1]?.id]);
  const plotHeightPx = model.weightsPublished ? WEIGHTED_PLOT_HEIGHT_PX : UNWEIGHTED_PLOT_HEIGHT_PX;
  const labels = placeLabels(ticks.filter((tick) => labelIds.has(tick.id)), driverIds, maxWeightUsd, rulePct, plotHeightPx);
  // The rule's own label sits on the side with fewer hung labels.
  const ruleLabelLeft =
    rulePct != null && (rulePct > 80 || labels.some((label) => label.anchor === "left"))
      && !labels.some((label) => label.anchor === "right");

  return (
    <figure className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium text-foreground">Run line</p>
        <p className="text-2xs text-muted-foreground">
          {model.weightsPublished ? "Each coin at its pressure; height is its gauge weight" : "Each coin at its pressure"}
          <span aria-hidden="true"> · </span>
          <span className="whitespace-nowrap">dashed: not in score</span>
        </p>
      </div>

      <div role="img" aria-label={describeRunLine(model)} className="flex gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: plotHeightPx + LABEL_HEADROOM_PX }}>
            <svg
              className="absolute inset-x-0 bottom-0 w-full overflow-visible"
              style={{ height: plotHeightPx }}
              viewBox={`0 0 200 ${plotHeightPx}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {/* Structural guides: band edges dashed, the 30-day norm (0) solid. */}
              <g className="text-border">
                {BAND_EDGES.map((edge) => (
                  <line
                    key={edge}
                    x1={edge + 100}
                    x2={edge + 100}
                    y1={0}
                    y2={plotHeightPx}
                    stroke="currentColor"
                    strokeWidth={1}
                    strokeDasharray="2 4"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <line
                  x1={100}
                  x2={100}
                  y1={0}
                  y2={plotHeightPx}
                  stroke="currentColor"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
              {/* Primary marks: one tick per scored coin. */}
              {ticks.map((tick) => (
                // Coin ticks stay muted so the gauge rule is the only full-ink mark.
                <g key={tick.id} className="text-muted-foreground/60">
                  <line
                    x1={tick.score + 100}
                    x2={tick.score + 100}
                    y1={plotHeightPx}
                    y2={plotHeightPx - tickHeightPx(tick.weightUsd, maxWeightUsd, plotHeightPx)}
                    stroke="currentColor"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* A wider transparent hit line gives the native hover title a usable target. */}
                  <line
                    x1={tick.score + 100}
                    x2={tick.score + 100}
                    y1={plotHeightPx}
                    y2={plotHeightPx - Math.max(tickHeightPx(tick.weightUsd, maxWeightUsd, plotHeightPx), 16)}
                    stroke="transparent"
                    strokeWidth={9}
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>
                      {`${tick.symbol}: ${formatAxis(Math.round(tick.score))}`}
                      {tick.weightUsd != null ? ` · weight ${formatCurrency(tick.weightUsd, 1)}` : ""}
                    </title>
                  </line>
                </g>
              ))}
              {/* The gauge: one ink rule across the full plot height. */}
              {score != null ? (
                <line
                  x1={score + 100}
                  x2={score + 100}
                  y1={0}
                  y2={plotHeightPx}
                  className="text-foreground"
                  stroke="currentColor"
                  strokeWidth={3}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </svg>

            {rulePct != null ? (
              // A cap marks the rule as the gauge, distinct from any tall coin tick beside it.
              <span
                className="absolute h-0.5 w-3 -translate-x-1/2 bg-foreground"
                style={{ left: `${rulePct}%`, top: LABEL_HEADROOM_PX }}
                aria-hidden="true"
              />
            ) : null}
            {rulePct != null ? (
              <span
                className={cn(
                  "absolute top-0 whitespace-nowrap text-2xs font-semibold text-foreground",
                  ruleLabelLeft ? "-translate-x-full pr-1.5" : "pl-1.5",
                )}
                style={{ left: `${rulePct}%` }}
                aria-hidden="true"
              >
                Gauge
              </span>
            ) : (
              <span className="absolute left-0 top-0 text-2xs text-muted-foreground" aria-hidden="true">
                Gauge not rated
              </span>
            )}
            {labels.map((label) => (
              <span
                key={label.id}
                className={cn(
                  "pharos-numeric absolute whitespace-nowrap text-2xs text-foreground/85",
                  label.anchor === "center" ? "-translate-x-1/2" : label.anchor === "left" ? "pl-1" : "-translate-x-full pr-1",
                )}
                style={{ left: `${label.pct}%`, bottom: label.anchor === "center" ? label.bottomPx : label.bottomPx - LABEL_LINE_PX }}
                aria-hidden="true"
              >
                {label.symbol}
              </span>
            ))}
          </div>

          {/* Band zones from the shared thresholds, tinted by the published band tones. */}
          <div className="flex h-6" aria-hidden="true">
            {GAUGE_BAND_RANGES.map((range) => (
              <div
                key={range.band}
                className={cn(
                  "flex min-w-0 items-center justify-center overflow-hidden border-y border-l first:rounded-l-sm last:rounded-r-sm last:border-r",
                  GAUGE_BAND_TONE_CLASSES[range.band],
                  range.band === band ? "opacity-100" : "opacity-80",
                )}
                style={{ width: `${(range.max - range.min) / 2}%` }}
              >
                <span
                  className={cn(
                    "truncate px-0.5 text-3xs font-medium",
                    // The beam's band chip names the band on phones; zones too narrow for it stay unlabelled.
                    range.band === band ? "hidden font-semibold sm:inline" : "hidden sm:inline",
                  )}
                >
                  {GAUGE_BAND_LABELS[range.band]}
                </span>
              </div>
            ))}
          </div>

          <div className="relative h-4" aria-hidden="true">
            {AXIS_LABELS.map((label) => (
              <span
                key={label.value}
                className={cn(
                  "pharos-numeric absolute top-0.5 text-3xs text-muted-foreground",
                  label.value === -100 ? "" : label.value === 100 ? "-translate-x-full" : "-translate-x-1/2",
                  label.mobile ? "" : "hidden sm:inline",
                )}
                style={{ left: `${toPct(label.value)}%` }}
              >
                {formatAxis(label.value)}
              </span>
            ))}
          </div>
        </div>

        <div className="w-12 shrink-0 sm:w-16">
          <GutterStubs stubs={stubs} maxWeightUsd={maxWeightUsd} plotHeightPx={plotHeightPx} />
          <div className="flex h-6 items-center justify-center rounded-sm border border-dashed border-border text-3xs font-semibold text-muted-foreground">
            <span className="pharos-numeric">{stubs.length}</span>
          </div>
          <p className="mt-0.5 text-center text-3xs leading-tight text-muted-foreground">not in score</p>
        </div>
      </div>

      <ChartDataTable
        caption={`Bank Run Gauge inputs: ${ticks.length} coins in the score, ${stubs.length} not in the score`}
        data={buildTableRows(model)}
        columns={RUN_LINE_TABLE_COLUMNS}
      />
    </figure>
  );
}
