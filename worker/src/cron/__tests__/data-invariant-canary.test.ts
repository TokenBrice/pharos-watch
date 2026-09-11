import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
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

    expect(result.status).toBe("skipped_neutral");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "off",
      skipped: true,
      reason: "worker-canary-mode-off",
    });
    expect(runAndPersistCanaryChecks).not.toHaveBeenCalled();
  });

  it("records shadow findings without changing scheduler health", async () => {
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

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(runAndPersistCanaryChecks).toHaveBeenCalledWith(expect.anything(), {
      observedAt: 1_775_900_000,
      signal: undefined,
      mode: "shadow",
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "shadow",
      observedStatus: "degraded",
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

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      mode: "shadow",
      observedAt: 1_775_900_000,
      persistFailed: true,
      persistError: "D1_ERROR: no such table: worker_canary_runs",
    });
  });

  it("applies mode precedence to the same error summary", async () => {
    for (const [mode, status] of [["shadow", "ok"], ["status", "degraded"], ["alert", "error"]] as const) {
      runAndPersistCanaryChecks.mockResolvedValueOnce({
        observedAt: 1_775_900_000, totalChecks: 1, okCount: 0, degradedCount: 0,
        errorCount: 1, skippedCount: 0, worstStatus: "error", worstSeverity: "warning", results: [],
      });
      expect((await runDataInvariantCanary(mockD1(), { mode })).status).toBe(status);
    }
  });

  it("escalates critical severity even without an error count", async () => {
    runAndPersistCanaryChecks.mockResolvedValueOnce({
      observedAt: 1_775_900_000, totalChecks: 1, okCount: 0, degradedCount: 1,
      errorCount: 0, skippedCount: 0, worstStatus: "degraded", worstSeverity: "critical", results: [],
    });
    expect((await runDataInvariantCanary(mockD1(), { mode: "alert" })).status).toBe("error");
  });

  it("reports persistence rejection according to operational mode", async () => {
    for (const [mode, status] of [["status", "degraded"], ["alert", "error"]] as const) {
      runAndPersistCanaryChecks.mockRejectedValueOnce(new Error("persistence failed"));
      const result = await runDataInvariantCanary(mockD1(), { mode });
      expect(result.status).toBe(status);
      expect(JSON.parse(result.metadata!)).toMatchObject({ persistFailed: true, persistError: "persistence failed" });
    }
  });

  it("propagates pre-existing cancellation without invoking persistence", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel canary");
    controller.abort(reason);
    await expect(runDataInvariantCanary(mockD1(), { mode: "shadow", signal: controller.signal })).rejects.toBe(reason);
    expect(runAndPersistCanaryChecks).not.toHaveBeenCalled();
  });

  it("does not turn cancellation during persistence rejection into fail-open success", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel persistence");
    runAndPersistCanaryChecks.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw new Error("D1 interrupted");
    });
    await expect(runDataInvariantCanary(mockD1(), { mode: "shadow", signal: controller.signal })).rejects.toBe(reason);
  });
});
