import { describe, expect, it } from "vitest";
import { assessD1QuotaUsage } from "@shared/lib/d1-capacity";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import { makePublicHealth } from "../../__tests__/public-health.test-support";
import {
  evaluateAvailabilityStatus,
  evaluateD1QuotaCauses,
  mergeD1QuotaCauses,
  type AvailabilityEvaluationInput,
} from "../evaluation-rules";

const READS_95_PERCENT_OBSERVED_24H = (25_000_000_000 * 95) / 100 / 30;
const WRITES_95_PERCENT_OBSERVED_24H = (50_000_000 * 95) / 100 / 30;

function quotaAt(readsPercent: number, writesPercent: number) {
  return assessD1QuotaUsage({
    rowsRead24h: (25_000_000_000 * readsPercent) / 100 / 30,
    rowsWritten24h: (50_000_000 * writesPercent) / 100 / 30,
  });
}

function makeAvailabilityInput(overrides: Partial<AvailabilityEvaluationInput> = {}): AvailabilityEvaluationInput {
  return {
    publicHealth: makePublicHealth(),
    availabilityImpactingCronErrors: 0,
    availabilityImpactingUnhealthyCrons: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
    watchUnhealthyCrons: 0,
    degradedCronRuns: 0,
    cronErrorCount: 0,
    cronHistoryQueryFailed: false,
    cronProgressQueryFailed: false,
    cronLeaseQueryFailed: false,
    ...overrides,
  };
}

describe("evaluateD1QuotaCauses", () => {
  it("adds no cause below the 80% watch floor", () => {
    expect(evaluateD1QuotaCauses(quotaAt(79.99, 79.99))).toEqual([]);
  });

  it("opens a watch cause at exactly 80% of both allowances", () => {
    expect(evaluateD1QuotaCauses(quotaAt(80, 0))).toEqual([
      expect.objectContaining({
        code: "d1_rows_read_quota_watch",
        layer: "availability",
        severity: "info",
        metric: "d1RowsReadQuotaPercent",
        value: 80,
        threshold: 80,
      }),
    ]);
    expect(evaluateD1QuotaCauses(quotaAt(0, 80))).toEqual([
      expect.objectContaining({ code: "d1_rows_written_quota_watch", severity: "info" }),
    ]);
  });

  it("stays on watch between 80% and 95%", () => {
    expect(evaluateD1QuotaCauses(quotaAt(90, 90))).toEqual([
      expect.objectContaining({ code: "d1_rows_read_quota_watch", severity: "info" }),
      expect.objectContaining({ code: "d1_rows_written_quota_watch", severity: "info" }),
    ]);
  });

  it("escalates to warning at exactly 95%", () => {
    expect(evaluateD1QuotaCauses(assessD1QuotaUsage({
      rowsRead24h: READS_95_PERCENT_OBSERVED_24H,
      rowsWritten24h: WRITES_95_PERCENT_OBSERVED_24H,
    }))).toEqual([
      expect.objectContaining({
        code: "d1_rows_read_quota_warning",
        severity: "warning",
        metric: "d1RowsReadQuotaPercent",
        value: 95,
        threshold: 95,
      }),
      expect.objectContaining({
        code: "d1_rows_written_quota_warning",
        severity: "warning",
        metric: "d1RowsWrittenQuotaPercent",
        value: 95,
        threshold: 95,
      }),
    ]);
  });

  it("keeps the warning above 95%", () => {
    expect(evaluateD1QuotaCauses(quotaAt(120, 120))).toEqual([
      expect.objectContaining({ code: "d1_rows_read_quota_warning", severity: "warning", value: 120 }),
      expect.objectContaining({ code: "d1_rows_written_quota_warning", severity: "warning", value: 120 }),
    ]);
  });

  it("adds no cause when usage is unavailable, never a zero-volume healthy signal", () => {
    const quota = assessD1QuotaUsage({ rowsRead24h: null, rowsWritten24h: null });

    expect(quota.rowsRead.utilizationPercent).toBeNull();
    expect(quota.rowsWritten.utilizationPercent).toBeNull();
    expect(evaluateD1QuotaCauses(quota)).toEqual([]);
    expect(evaluateD1QuotaCauses(null)).toEqual([]);
  });

  it("never changes public health or the public-impact classification", () => {
    const baseline = evaluateAvailabilityStatus(makeAvailabilityInput());
    const merged = mergeD1QuotaCauses(baseline.causes, quotaAt(140, 140));

    expect(baseline.status).toBe("healthy");
    expect(merged.map((cause) => cause.code)).toEqual([
      "d1_rows_read_quota_warning",
      "d1_rows_written_quota_warning",
    ]);
    expect(transitionHasPublicImpact(merged)).toBe(false);
  });

  it("replaces stale quota causes instead of duplicating them", () => {
    const stale = evaluateD1QuotaCauses(quotaAt(100, 0));
    const merged = mergeD1QuotaCauses(stale, quotaAt(80, 0));

    expect(merged).toEqual([
      expect.objectContaining({ code: "d1_rows_read_quota_watch", value: 80 }),
    ]);
  });
});
