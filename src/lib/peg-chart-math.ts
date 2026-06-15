/**
 * Snap the Y-axis domain symmetrically around the $1 peg target so upside and
 * downside deviation are visually equivalent. Step is chosen so ~4-6 ticks
 * cover the range.
 */
const TICK_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2];

export function computePegYAxis(prices: number[]): {
  domain: [number, number];
  ticks: number[];
  step: number;
} {
  if (prices.length === 0) {
    return { domain: [0.98, 1.02], ticks: [0.98, 0.99, 1, 1.01, 1.02], step: 0.01 };
  }
  let half = 0;
  for (const p of prices) {
    const d = Math.abs(p - 1);
    if (d > half) half = d;
  }
  // Floor at 50 bps so quiet pegs still show the in-band breathing room.
  if (half < 0.005) half = 0.005;

  let step = TICK_STEPS[TICK_STEPS.length - 1];
  for (const candidate of TICK_STEPS) {
    if (candidate >= (2 * half) / 5) {
      step = candidate;
      break;
    }
  }

  const padded = Math.ceil(half / step + 1e-9) * step;
  const domainMin = 1 - padded;
  const domainMax = 1 + padded;

  const ticks: number[] = [];
  for (let t = domainMin; t <= domainMax + 1e-9; t += step) {
    ticks.push(Number(t.toFixed(6)));
  }
  return { domain: [domainMin, domainMax], ticks, step };
}

/**
 * Single-pole exponential moving average over a price series. `alpha` is
 * chosen by caller based on range so longer windows get heavier smoothing.
 */
export function ewma(values: number[], alpha: number): number[] {
  if (values.length === 0) return [];
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  }
  return out;
}
