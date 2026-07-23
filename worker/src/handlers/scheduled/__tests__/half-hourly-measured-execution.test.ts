import { describe, expect, it } from "vitest";

import type { CronResult } from "../../../lib/cron-logger";
import { mergeMeasuredExecutionResults } from "../half-hourly-measured-execution";

function result(
  status: NonNullable<CronResult["status"]>,
  lane: string,
  attemptedFailureCount = 0,
  cursor?: { deferredCount: number; cursorWriteStatus: string },
): CronResult {
  return {
    status,
    itemCount: 1,
    metadata: JSON.stringify({ lane, attemptedFailureCount, ...cursor }),
    productivity: { productive: true, reason: `${lane}-published` },
  };
}

describe("half-hourly measured execution result aggregation", () => {
  it("retains shadow degradation as diagnostics without degrading active EVM health", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm"),
      result("degraded", "solana", 3),
      result("degraded", "tron", 2),
    );
    const metadata = JSON.parse(merged.metadata!);

    expect(merged.status).toBe("ok");
    expect(metadata.laneStatuses).toEqual({
      evm: "ok",
      solana: "degraded",
      tron: "degraded",
    });
    expect(metadata.solana.attemptedFailureCount).toBe(3);
    expect(metadata.tron.attemptedFailureCount).toBe(2);
  });

  it("preserves active EVM degradation", () => {
    const merged = mergeMeasuredExecutionResults(
      result("degraded", "evm", 1),
      result("ok", "solana"),
      result("ok", "tron"),
    );

    expect(merged.status).toBe("degraded");
  });

  it("preserves a non-durable shadow deferral as degradation", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm"),
      result("degraded", "solana", 0, {
        deferredCount: 4,
        cursorWriteStatus: "write-failed",
      }),
      result("ok", "tron"),
    );

    expect(merged.status).toBe("degraded");
  });

  it("keeps a shadow invocation error terminal", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm"),
      result("error", "solana", 1),
      result("ok", "tron"),
    );

    expect(merged.status).toBe("error");
  });
});
