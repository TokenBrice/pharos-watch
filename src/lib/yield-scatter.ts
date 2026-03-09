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
