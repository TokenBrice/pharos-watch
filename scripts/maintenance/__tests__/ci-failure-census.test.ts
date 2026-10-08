import { describe, expect, it } from "vitest";
import { classifyCancellation, computeCohorts, computeMetrics, utcDate, workflowKind, type Execution, type Run } from "../ci-failure-census";

function run(id: number, branch: string, conclusion: string | null, attempt = 1): Run {
  return { id, head_branch: branch, head_sha: `sha-${id}`, created_at: `2026-10-01T${String(id).padStart(2, "0")}:00:00Z`, conclusion, run_attempt: attempt };
}
describe("CI failure census", () => {
  it("cuts UTC created_at cohorts at midnight and retains the matching attempts only", () => {
    const runs = [
      { ...run(1, "shared", "failure"), created_at: "2026-10-05T23:59:59Z" },
      { ...run(2, "shared", "success", 2), created_at: "2026-10-06T00:00:00Z" },
    ];
    const executions = [runs[0], { ...runs[1], conclusion: "failure", run_attempt: 1 }, runs[1]];
    const cohorts = computeCohorts(runs, executions, "2026-10-06");
    expect(cohorts.before.failedAll.numerator).toBe(1);
    expect(cohorts.before.censored).toHaveLength(1);
    expect(cohorts.onward.firstRunIdGreenObserved.numerator).toBe(1);
    expect(cohorts.onward.executionAttemptsToFirstGreen).toEqual({ 2: 1 });
  });
  it("groups chronological run IDs by branch, including cancellations and excluding post-green IDs", () => {
    const runs = [run(4, "retry", "success", 2), run(1, "first", "success"), run(2, "retry", "cancelled"), run(3, "retry", "failure"), run(5, "first", "failure"), run(6, "censored", "failure")];
    const executions: Execution[] = [...runs.map((item) => ({ ...item, cancellation: item.id === 2 ? "superseded" as const : undefined })), { ...runs[0], run_attempt: 1, conclusion: "failure" }];
    const metrics = computeMetrics(runs, executions);
    expect(metrics.failedAll).toEqual({ numerator: 3, denominator: 6, fraction: 0.5 });
    expect(metrics.failedNonCancelled).toEqual({ numerator: 3, denominator: 5, fraction: 0.6 });
    expect(metrics.firstRunIdGreenObserved).toEqual({ numerator: 1, denominator: 2, fraction: 0.5 });
    expect(metrics.firstRunIdGreenAllBranches.denominator).toBe(3);
    expect(metrics.attemptsToFirstGreen).toEqual({ 1: 1, 3: 1 });
    expect(metrics.executionAttemptsToFirstGreen).toEqual({ 1: 1, 4: 1 });
    expect(metrics.retryingBranches).toEqual({ count: 1, mean: 3, median: 3 });
    expect(metrics.extraPreGreenRunIds).toBe(2);
    expect(metrics.censored).toEqual([{ branch: "censored", runIds: [6], executions: 1 }]);
    expect(metrics.concurrencySuperseded).toBe(1);
    expect(metrics.failedExecutions).toBe(4);
    expect(metrics.priorExecutions).toBe(1);
  });
  it("reports the mean and even-sample median only among retrying branches", () => {
    const runs = [
      run(1, "two", "failure"), run(2, "two", "success"),
      run(3, "three", "cancelled"), run(4, "three", "failure"), run(5, "three", "success"),
      run(6, "first", "success"),
    ];
    expect(computeMetrics(runs, runs).retryingBranches).toEqual({ count: 2, mean: 2.5, median: 2.5 });
  });
  it("keeps unknown cancellations distinct and does not treat pending branches as green", () => {
    const runs = [run(1, "cancel", "cancelled"), run(2, "pending", null)];
    const metrics = computeMetrics(runs, runs);
    expect(metrics.unknownCancellations).toBe(1);
    expect(metrics.concurrencySuperseded).toBe(0);
    expect(metrics.pending).toBe(1);
    expect(metrics.censored).toHaveLength(2);
    expect(metrics.firstRunIdGreenObserved.fraction).toBeNull();
    expect(computeMetrics([], []).failedAll.fraction).toBeNull();
  });
  it("counts rerun success as first-run-ID green but not first-execution green", () => {
    const latest = run(1, "rerun", "success", 3);
    const metrics = computeMetrics([latest], [{ ...latest, run_attempt: 1, conclusion: "failure" }, { ...latest, run_attempt: 2, conclusion: "failure" }, latest]);
    expect(metrics.attemptsToFirstGreen).toEqual({ 1: 1 });
    expect(metrics.executionAttemptsToFirstGreen).toEqual({ 3: 1 });
    expect(metrics.retryingBranches.count).toBe(0);
    expect(metrics.retryingExecutionBranches.mean).toBe(3);
  });
  it("recognizes annotation evidence without guessing", () => {
    expect(classifyCancellation([{ message: "Canceling since a higher priority waiting request for this workflow exists" }])).toBe("superseded");
    expect(classifyCancellation([{ message: "The workflow was cancelled by maintainer" }])).toBe("other");
    expect(classifyCancellation([{ message: "The operation was canceled." }])).toBe("unknown");
  });
  it("validates UTC calendar dates and classifies workflow inventories", () => {
    expect(utcDate("2026-10-08", "since")).toBe("2026-10-08");
    expect(() => utcDate("2026-02-30", "since")).toThrow();
    expect(() => utcDate("2026-99-99", "since")).toThrow();
    expect(workflowKind(".github/workflows/pull-request-checks.yml")).toBe("pr");
    expect(workflowKind(".github/workflows/weekly-dependency-coverage.yml")).toBe("weekly");
    expect(workflowKind(".github/workflows/dependency-scenarios-refresh.yml")).toBe("refresh");
  });
});
