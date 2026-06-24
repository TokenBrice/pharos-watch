import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { runDataInvariantCanary } from "../data-invariant-canary";

const runAndPersistCanaryChecks = vi.hoisted(() => vi.fn());

vi.mock("../../lib/canary-checks", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/canary-checks")>();
  return {
    ...original,
    runAndPersistCanaryChecks,
  };
});

describe("runDataInvariantCanary", () => {
  beforeEach(() => {
    runAndPersistCanaryChecks.mockReset();
  });

  it("skips without D1 writes when canary mode is off", async () => {
    const result = await runDataInvariantCanary(mockD1(), { mode: undefined, observedAt: 1_775_900_000 });

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "off",
      skipped: true,
      reason: "worker-canary-mode-off",
    });
    expect(runAndPersistCanaryChecks).not.toHaveBeenCalled();
  });

  it("records shadow canary results and returns degraded when any check fails", async () => {
    runAndPersistCanaryChecks.mockResolvedValueOnce({
      mode: "shadow",
      observedAt: 1_775_900_000,
      totalChecks: 2,
      okCount: 1,
      degradedCount: 1,
      errorCount: 0,
      skippedCount: 0,
      worstStatus: "degraded",
      worstSeverity: "warning",
      results: [
        {
          checkId: "ok-check",
          status: "ok",
          severity: "info",
          durationMs: 4,
        },
        {
          checkId: "warn-check",
          status: "degraded",
          severity: "warning",
          durationMs: 7,
          error: "warning",
        },
      ],
    });

    const result = await runDataInvariantCanary(mockD1(), { mode: "shadow", observedAt: 1_775_900_000 });

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(2);
    expect(runAndPersistCanaryChecks).toHaveBeenCalledWith(expect.anything(), {
      observedAt: 1_775_900_000,
      signal: undefined,
      mode: "shadow",
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "shadow",
      degradedCount: 1,
      checks: [
        { checkId: "ok-check", status: "ok", severity: "info", durationMs: 4 },
        { checkId: "warn-check", status: "degraded", severity: "warning", durationMs: 7, error: "warning" },
      ],
    });
  });

  it("fails open when shadow persistence is unavailable", async () => {
    runAndPersistCanaryChecks.mockRejectedValueOnce(new Error("D1_ERROR: no such table: worker_canary_runs"));

    const result = await runDataInvariantCanary(mockD1(), { mode: "shadow", observedAt: 1_775_900_000 });

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "shadow",
      observedAt: 1_775_900_000,
      persistFailed: true,
      persistError: "D1_ERROR: no such table: worker_canary_runs",
    });
  });
});
