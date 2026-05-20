import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { recordCronFailure, __resetCronFailureCountsForTests } from "../cron-logger";

describe("recordCronFailure", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetCronFailureCountsForTests();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("classifies Error instances and includes jobName, name, message, and count", () => {
    const result = recordCronFailure("snapshot-supply", new TypeError("bad thing"));

    expect(result).toMatchObject({
      job: "snapshot-supply",
      errorName: "TypeError",
      errorMessage: "bad thing",
      failureCount: 1,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const [prefix, payload] = errorSpy.mock.calls[0] as [string, string];
    expect(prefix).toContain("[cron-failure:snapshot-supply]");
    expect(prefix).toContain("TypeError");

    const parsed = JSON.parse(payload);
    expect(parsed).toMatchObject({
      event: "cron_failure",
      job: "snapshot-supply",
      errorName: "TypeError",
      errorMessage: "bad thing",
      failureCount: 1,
    });
  });

  it("classifies non-Error throwables (string, object) without throwing", () => {
    const stringResult = recordCronFailure("project-tape", "kaboom");
    expect(stringResult).toMatchObject({
      job: "project-tape",
      errorName: "NonError",
      errorMessage: "kaboom",
      failureCount: 1,
    });

    const objectResult = recordCronFailure("project-tape", { reason: "oops" });
    expect(objectResult.job).toBe("project-tape");
    expect(objectResult.errorName).toBe("NonError");
    expect(objectResult.failureCount).toBe(2);
  });

  it("increments the per-job counter across calls and keeps jobs independent", () => {
    const a1 = recordCronFailure("job-a", new Error("a1"));
    const a2 = recordCronFailure("job-a", new Error("a2"));
    const b1 = recordCronFailure("job-b", new Error("b1"));

    expect(a1.failureCount).toBe(1);
    expect(a2.failureCount).toBe(2);
    expect(b1.failureCount).toBe(1);
  });

  it("attaches caller-supplied metadata to the structured payload", () => {
    recordCronFailure("snapshot-chain-supply", new Error("write failed"), {
      metadata: { stage: "batchExecute", attempt: 3 },
    });

    const [, payload] = errorSpy.mock.calls[0] as [string, string];
    const parsed = JSON.parse(payload);
    expect(parsed.metadata).toEqual({ stage: "batchExecute", attempt: 3 });
  });
});
