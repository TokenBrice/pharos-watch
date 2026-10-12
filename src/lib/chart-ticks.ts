/* ═══════════════════════════════════════════════════════════════════
   Nice axis ticks
   One rule for every numeric axis, Recharts or hand-rolled SVG: tick
   steps are 1, 2, 2.5 or 5 × 10^n, and an extended domain ends on a tick.
   Recharts' own `niceTicks="snap125"` uses the same step set; pass explicit
   `ticks`/`domain` from here whenever a chart fixes or pads its domain,
   because Recharts then appends the raw domain end as an extra tick.
   ═══════════════════════════════════════════════════════════════════ */

import { formatCurrency, formatPercent } from "@shared/lib/format";

/**
 * - `number` / `currency`: any 1/2/2.5/5 step.
 * - `percent`: same steps; an extension never crosses 0 or 100 when the data
 *   stays inside them.
 * - `score`: a bounded 0–100 score; integer steps only (2.5 → 25 and up).
 * - `bps` / `count`: integer steps only.
 */
export type TickKind = "number" | "currency" | "percent" | "score" | "bps" | "count";

export interface NiceTicksOptions {
  /** Target tick count, including both ends. Default 5. */
  count?: number;
  kind?: TickKind;
  /**
   * `true` (default): widen the domain outward to the nearest ticks.
   * `false`: keep the domain exactly and label only the ticks inside it,
   * e.g. a display rail that must stay at its true value.
   */
  extend?: boolean;
  /** Pull the domain to include zero. Default false. */
  includeZero?: boolean;
}

export interface NiceTicks {
  domain: [number, number];
  ticks: number[];
  step: number;
}

const STEP_MANTISSAS = [1, 2, 2.5, 5, 10] as const;
const EMPTY_TICKS: NiceTicks = { domain: [0, 1], ticks: [], step: 0 };

function isIntegerKind(kind: TickKind): boolean {
  return kind === "score" || kind === "bps" || kind === "count";
}

function decimalsOf(step: number): number {
  // 2.5e-3 → 4 decimals; integers → 0.
  for (let d = 0; d <= 12; d++) {
    if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d;
  }
  return 12;
}

function roundTo(value: number, decimals: number): number {
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Candidate 1/2/2.5/5 × 10^n steps around a rough step, ascending. */
function candidateSteps(rough: number, integer: boolean): number[] {
  const exponent = Math.floor(Math.log10(rough));
  const steps: number[] = [];
  for (let e = exponent - 1; e <= exponent + 1; e++) {
    for (const mantissa of STEP_MANTISSAS) {
      const step = mantissa * 10 ** e;
      if (integer && !Number.isInteger(roundTo(step, 9))) continue;
      steps.push(roundTo(step, Math.max(0, -e + 1)));
    }
  }
  return [...new Set(steps)].sort((a, b) => a - b);
}

function resolveSpan(min: number, max: number): [number, number] {
  if (max > min) return [min, max];
  // Degenerate span: open a window so a flat series still gets ticks.
  if (min === 0) return [0, 1];
  const pad = Math.abs(min) * 0.1;
  return [min - pad, max + pad];
}

/**
 * Nice ticks for a linear axis over [min, max]. Non-finite input returns no
 * ticks: an unavailable series must not invent an axis.
 */
export function niceTicks(min: number, max: number, options: NiceTicksOptions = {}): NiceTicks {
  const { count = 5, kind = "number", extend = true, includeZero = false } = options;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return EMPTY_TICKS;

  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const nonNegative = lo >= 0;
  const withinWhole = hi <= 100;
  [lo, hi] = resolveSpan(lo, hi);

  const target = Math.max(2, Math.round(count));
  const integer = isIntegerKind(kind);
  const rough = (hi - lo) / (target - 1);

  let best: { step: number; start: number; end: number; n: number; score: number } | null = null;
  for (const step of candidateSteps(rough, integer)) {
    const decimals = decimalsOf(step);
    const start = roundTo(extend ? Math.floor(lo / step + 1e-9) * step : Math.ceil(lo / step - 1e-9) * step, decimals);
    const end = roundTo(extend ? Math.ceil(hi / step - 1e-9) * step : Math.floor(hi / step + 1e-9) * step, decimals);
    const n = Math.round((end - start) / step) + 1;
    if (n < 2) continue;
    // Closest tick count wins, with a penalty for empty range an extension
    // adds; ties prefer the larger, calmer step.
    const coverage = extend ? (hi - lo) / (end - start || 1) : 1;
    const score = Math.abs(n - target) + 2 * (1 - coverage);
    if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && step > best.step)) {
      best = { step, start, end, n, score };
    }
  }
  if (!best) return { domain: [lo, hi], ticks: [lo, hi], step: hi - lo };

  const decimals = decimalsOf(best.step);
  const ticks = Array.from({ length: best.n }, (_, i) => roundTo(best.start + i * best.step, decimals));
  let domain: [number, number] = extend ? [best.start, best.end] : [lo, hi];

  // Never let an extension invent a sign or a share beyond the whole.
  const bounded = kind === "percent" || kind === "score";
  if (extend && nonNegative && domain[0] < 0) domain = [0, domain[1]];
  if (extend && bounded && withinWhole && domain[1] > 100) domain = [domain[0], 100];
  const visible = ticks.filter((tick) => tick >= domain[0] - 1e-9 && tick <= domain[1] + 1e-9);

  return { domain, ticks: visible, step: best.step };
}

/** Nice ticks over the finite members of a series; unavailable values are ignored, never read as zero. */
export function niceTicksForValues(values: ReadonlyArray<number | null | undefined>, options: NiceTicksOptions = {}): NiceTicks {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === Infinity) return EMPTY_TICKS;
  return niceTicks(min, max, options);
}

/**
 * Log-axis ticks: powers of ten, plus 2× and 5× when the domain spans at most
 * two decades. Non-positive bounds return no ticks.
 */
export function logTicks(min: number, max: number, { extend = true }: { extend?: boolean } = {}): NiceTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return EMPTY_TICKS;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const loExp = Math.floor(Math.log10(lo) + 1e-9);
  const hiExp = Math.ceil(Math.log10(hi) - 1e-9);
  const mantissas = hiExp - loExp <= 2 ? [1, 2, 5] : [1];
  const domain: [number, number] = extend ? [10 ** loExp, 10 ** Math.max(hiExp, loExp + 1)] : [lo, hi];

  const ticks: number[] = [];
  for (let e = loExp; e <= Math.max(hiExp, loExp + 1); e++) {
    for (const mantissa of mantissas) {
      const tick = roundTo(mantissa * 10 ** e, Math.max(0, -e));
      if (tick >= domain[0] * (1 - 1e-9) && tick <= domain[1] * (1 + 1e-9)) ticks.push(tick);
    }
  }
  // Inside a single decade the 1/2/5 marks can leave one label; nice linear
  // values on the log-scaled axis read better than a bare axis.
  if (ticks.length < 3) return { ...niceTicks(domain[0], domain[1], { extend: false }), domain };
  return { domain, ticks, step: 0 };
}

const TIME_STEP_MONTHS = [1, 3, 6, 12, 24, 60, 120] as const;

export interface NiceTimeTicks {
  ticks: number[];
  /** Months between ticks; 12 or more means label by year. */
  stepMonths: number;
}

/**
 * Calendar ticks on UTC month starts aligned to the step (quarters start in
 * Jan/Apr/Jul/Oct, multi-year steps on even years), using the finest step
 * that keeps at most `count` ticks inside [start, end].
 */
export function niceTimeTicks(start: number, end: number, count = 6): NiceTimeTicks {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { ticks: [], stepMonths: 0 };
  const first = new Date(start);
  const startIndex = first.getUTCFullYear() * 12 + first.getUTCMonth() + (first.getUTCDate() > 1 || start % 86_400_000 !== 0 ? 1 : 0);
  for (const step of TIME_STEP_MONTHS) {
    const ticks: number[] = [];
    for (let index = Math.ceil(startIndex / step) * step; ; index += step) {
      const tick = Date.UTC(Math.floor(index / 12), index % 12, 1);
      if (tick > end) break;
      ticks.push(tick);
    }
    if (ticks.length <= Math.max(2, count)) return { ticks, stepMonths: step };
  }
  return { ticks: [], stepMonths: 0 };
}

/** Drop trailing fractional zeros: "$2.500M" → "$2.5M", "$1.000B" → "$1B". */
function trimFractionZeros(label: string): string {
  return label.replace(/(\.\d*?)0+(?=\D*$)/, "$1").replace(/\.(?=\D*$)/, "");
}

/**
 * Wrap a precision-taking formatter so each tick gets the fewest decimals
 * that state it exactly: a 2.5 step reads "$2.5M", never "$3M", and distinct
 * ticks never collapse into one label ("$1B $1B").
 */
export function exactTickFormatter(
  format: (value: number, decimals: number) => string,
  maxDecimals = 4,
): (value: number) => string {
  return (value) => {
    const exact = trimFractionZeros(format(value, maxDecimals));
    for (let decimals = 0; decimals < maxDecimals; decimals++) {
      const label = format(value, decimals);
      if (trimFractionZeros(label) === exact) return label;
    }
    return exact;
  };
}

/** Compact USD tick labels ("$0", "$2.5M", "$1.25B"), exact at every nice step. */
export const formatCurrencyTick = exactTickFormatter(formatCurrency);

/** Percent tick labels ("2%", "2.5%"), exact at every nice step. */
export const formatPercentTick = exactTickFormatter(formatPercent);
