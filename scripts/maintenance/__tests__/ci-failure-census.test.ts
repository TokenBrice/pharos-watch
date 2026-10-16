import { describe, expect, it } from "vitest";
import { classifyCancellation, computeMetrics, type Run } from "../ci-failure-census";

function run(id: number, branch: string, conclusion: string | null, attempt = 1): Run {
  return { id, head_branch: branch, head_sha: `sha-${id}`, created_at: `2026-10-01T${String(id).padStart(2, "0")}:00:00Z`, conclusion, run_attempt: attempt };
}
describe("CI failure census", () => {
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
  it("recognizes annotation evidence without guessing", () => {
    expect(classifyCancellation([{ message: "Canceling since a higher priority waiting request for this workflow exists" }])).toBe("superseded");
    expect(classifyCancellation([{ message: "The workflow was cancelled by maintainer" }])).toBe("other");
    expect(classifyCancellation([{ message: "The operation was canceled." }])).toBe("unknown");
  });
});
