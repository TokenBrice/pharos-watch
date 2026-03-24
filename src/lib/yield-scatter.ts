export const SAFETY_SCORE_THRESHOLD = 60;

const SAFETY_WINDOW_STEP = 5;
const SAFETY_WINDOW_BUFFER = 5;
const APY_AXIS_STEP = 1;
const APY_AXIS_MIN = 8;
const APY_OUTLIER_MIN_ROWS = 12;
const APY_OUTLIER_SHARE = 0.08;
const APY_OUTLIER_RATIO = 1.35;

interface ApyAxisConfig {
  domainMax: number;
  clipThreshold: number | null;
  clippedCount: number;
}

function roundDown(value: number, step: number) {
  return Math.floor(value / step) * step;
}

function roundUp(value: number, step: number) {
  return Math.ceil(value / step) * step;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function percentile(sortedValues: number[], p: number) {
  if (sortedValues.length === 0) return 0;

  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export function computeSafetyDomain(scores: number[], isMobile: boolean): [number, number] {
  if (scores.length === 0) return [0, 100];

  const padding = isMobile ? 2 : 3;
  const minSpan = isMobile ? 25 : 30;

  let start = roundDown(Math.min(...scores) - padding, SAFETY_WINDOW_STEP);
  let end = roundUp(Math.max(...scores) + padding, SAFETY_WINDOW_STEP);

  start = Math.min(start, SAFETY_SCORE_THRESHOLD - SAFETY_WINDOW_BUFFER);
  end = Math.max(end, SAFETY_SCORE_THRESHOLD + SAFETY_WINDOW_BUFFER);

  if (end - start < minSpan) {
    const midpoint = (start + end) / 2;
    start = midpoint - minSpan / 2;
    end = midpoint + minSpan / 2;
  }

  if (start < 0) {
    end = Math.min(100, end - start);
    start = 0;
  }

  if (end > 100) {
    start = Math.max(0, start - (end - 100));
    end = 100;
  }

  start = Math.max(0, roundDown(start, SAFETY_WINDOW_STEP));
  end = Math.min(100, roundUp(end, SAFETY_WINDOW_STEP));

  if (end - start < minSpan) {
    if (start === 0) {
      end = Math.min(100, roundUp(start + minSpan, SAFETY_WINDOW_STEP));
    } else if (end === 100) {
      start = Math.max(0, roundDown(end - minSpan, SAFETY_WINDOW_STEP));
    }
  }

  return [start, end];
}

// ---------------------------------------------------------------------------
// Overlap nudging — push apart scatter points whose logos would fully overlap
// ---------------------------------------------------------------------------

const LOGO_DIAMETER_DESKTOP = 16;
const LOGO_DIAMETER_MOBILE = 14;

interface NudgeablePoint {
  plotX: number;
  plotY: number;
}

/**
 * Detect scatter points whose logo circles overlap and apply small
 * deterministic coordinate offsets to separate them. Original `x` / `y`
 * values stay intact for tooltips; only `plotX` / `plotY` are adjusted.
 */
export function nudgeOverlaps<T extends NudgeablePoint>(
  points: T[],
  xDomain: [number, number],
  yDomain: [number, number],
  chartWidth: number,
  chartHeight: number,
  mobile: boolean,
): T[] {
  if (points.length <= 1) return points;

  const result = points.map((p) => ({ ...p }));
  const logoDiam = mobile ? LOGO_DIAMETER_MOBILE : LOGO_DIAMETER_DESKTOP;
  const xSpan = xDomain[1] - xDomain[0];
  const ySpan = yDomain[1] - yDomain[0];
  if (xSpan === 0 || ySpan === 0 || chartWidth === 0 || chartHeight === 0) return result;

  // Collision threshold: one logo diameter in data-space units
  const xThresh = (logoDiam / chartWidth) * xSpan;
  const yThresh = (logoDiam / chartHeight) * ySpan;

  // Push distance per pass (each point moves half this amount)
  const pushX = xThresh * 0.6;
  const pushY = yThresh * 0.6;

  // Iterative collision resolution (max 3 passes for chained clusters)
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const dx = result[j].plotX - result[i].plotX;
        const dy = result[j].plotY - result[i].plotY;
        if (Math.abs(dx) >= xThresh || Math.abs(dy) >= yThresh) continue;

        // Deterministic angle — 45° for near-exact overlaps
        const angle =
          Math.abs(dx) < xThresh * 0.05 && Math.abs(dy) < yThresh * 0.05
            ? Math.PI / 4
            : Math.atan2(dy, dx);

        const cx = pushX * 0.5 * Math.cos(angle);
        const cy = pushY * 0.5 * Math.sin(angle);
        result[i].plotX -= cx;
        result[i].plotY -= cy;
        result[j].plotX += cx;
        result[j].plotY += cy;
        result[i].plotX = clamp(result[i].plotX, xDomain[0], xDomain[1]);
        result[i].plotY = clamp(result[i].plotY, yDomain[0], yDomain[1]);
        result[j].plotX = clamp(result[j].plotX, xDomain[0], xDomain[1]);
        result[j].plotY = clamp(result[j].plotY, yDomain[0], yDomain[1]);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// APY axis computation
// ---------------------------------------------------------------------------

export function computeApyAxis(apys: number[], riskFreeRate: number): ApyAxisConfig {
  if (apys.length === 0) {
    return {
      domainMax: Math.max(APY_AXIS_MIN, roundUp(riskFreeRate + 4, APY_AXIS_STEP)),
      clipThreshold: null,
      clippedCount: 0,
    };
  }

  const sorted = [...apys].sort((a, b) => a - b);
  const naturalMax = sorted[sorted.length - 1];
  const paddedMax = roundUp(Math.max(riskFreeRate + 4, naturalMax * 1.08), APY_AXIS_STEP);
  const q75 = percentile(sorted, 0.75);
  const q90 = percentile(sorted, 0.9);
  const candidateThreshold = roundUp(Math.max(riskFreeRate + 6, q75 + 3, q90 * 1.25), APY_AXIS_STEP);
  const clippedCount = sorted.filter((value) => value > candidateThreshold).length;
  const maxOutliers = Math.max(1, Math.floor(sorted.length * APY_OUTLIER_SHARE));
  const shouldClip =
    sorted.length >= APY_OUTLIER_MIN_ROWS &&
    clippedCount > 0 &&
    clippedCount <= maxOutliers &&
    naturalMax >= candidateThreshold * APY_OUTLIER_RATIO;

  if (!shouldClip) {
    return {
      domainMax: Math.max(APY_AXIS_MIN, paddedMax),
      clipThreshold: null,
      clippedCount: 0,
    };
  }

  return {
    domainMax: Math.max(APY_AXIS_MIN, candidateThreshold),
    clipThreshold: candidateThreshold,
    clippedCount,
  };
}
