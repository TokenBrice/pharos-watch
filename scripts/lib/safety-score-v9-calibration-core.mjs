import { V9_CANDIDATE_POLICY_V1 } from "../../shared/lib/safety-score-v9/policy.ts";
import { stableJsonStringifyV1 as stableStringify } from "../../shared/lib/stable-json.ts";
export { stableStringify };
export function deriveCalibrationGradePolicy(formula) {
  const thresholds = formula.gradeThresholds;
  const scoreQuantum = 10 ** -formula.scoreDecimals;
  const ranges = Object.fromEntries(
    thresholds.map((threshold, index) => [
      threshold.grade,
      {
        minScore: threshold.minScore,
        maxScore: index === 0 ? 100 : thresholds[index - 1].minScore - scoreQuantum,
      },
    ]),
  );
  return {
    order: [...thresholds.map((threshold) => threshold.grade), "NR"],
    boundaries: [
      ...thresholds
        .map((threshold) => threshold.minScore)
        .filter((minimum) => minimum > 0)
        .sort((left, right) => left - right),
      100,
    ],
    ranges,
  };
}
export const CALIBRATION_GRADE_POLICY = deriveCalibrationGradePolicy(
  V9_CANDIDATE_POLICY_V1.policy.semantic.formula,
);
export const GRADE_ORDER = CALIBRATION_GRADE_POLICY.order;
export const GRADE_BOUNDARIES = CALIBRATION_GRADE_POLICY.boundaries;
export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}
export function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
export function countsBy(values, keyOf) {
  const counts = new Map();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || compareText(left.key, right.key));
}
export function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
export function requireExactKeys(value, keys, label) {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`${label} does not match the closed production identity shape`);
  }
  return record;
}
export function uniqueAssetIds(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${label} must contain nonempty asset IDs`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} must contain unique asset IDs`);
  return [...values].sort(compareText);
}
