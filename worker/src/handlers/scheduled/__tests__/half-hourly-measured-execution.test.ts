import { describe, expect, it } from "vitest";

import type { CronResult } from "../../../lib/cron-logger";
import { mergeMeasuredExecutionResults } from "../half-hourly-measured-execution";

function result(
  status: NonNullable<CronResult["status"]>,
  lane: string,
  attemptedFailureCount = 0,
  metadata?: Record<string, unknown>,
): CronResult {
  return {
    status,
    itemCount: 1,
    metadata: JSON.stringify({ lane, attemptedFailureCount, ...metadata }),
    productivity: { productive: true, reason: `${lane}-published` },
  };
}

describe("half-hourly measured execution result aggregation", () => {
  it("retains shadow Solana degradation as diagnostics without degrading active lanes", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm"),
      result("degraded", "solana", 3, { activation: "target-ratified" }),
      result("ok", "tron", 0, { activation: "active" }),
    );
    const metadata = JSON.parse(merged.metadata!);

    expect(merged.status).toBe("ok");
    expect(metadata.laneStatuses).toEqual({
      evm: "ok",
      solana: "degraded",
      tron: "ok",
    });
    expect(metadata.solana.attemptedFailureCount).toBe(3);
  });

  it("degrades when an active native lane has attempted failures", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm"),
      result("ok", "solana", 0, { activation: "target-ratified" }),
      result("degraded", "tron", 2, { activation: "active" }),
    );

    expect(merged.status).toBe("degraded");
  });

  it("retains shadow Tron quote failures as diagnostics", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm"),
      result("ok", "solana", 0, { activation: "target-ratified" }),
      result("degraded", "tron", 1, {
        activation: "shadow",
        cursorWriteStatus: "not-needed",
        failuresByReason: { "profile-validation:quote-price-mismatch": 1 },
      }),
    );
    const metadata = JSON.parse(merged.metadata!);

    expect(merged.status).toBe("ok");
    expect(metadata.laneStatuses.tron).toBe("degraded");
    expect(metadata.tron.activation).toBe("shadow");
    expect(metadata.tron.attemptedFailureCount).toBe(1);
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

  it("preserves a non-durable Tron rate-limit tail as degradation", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm"),
      result("ok", "solana"),
      result("degraded", "tron", 0, {
        deferredCount: 0,
        rateLimitDeferredCount: 2,
        cursorWriteStatus: "missing-table",
      }),
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
