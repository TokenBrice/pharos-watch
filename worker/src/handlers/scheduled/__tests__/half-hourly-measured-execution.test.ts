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

  it("hoists evidence-ledger scalars from the daily-0810 shadow lane to the merged top level", () => {
    // Producer history keeps only top-level scalar metadata; nested lane
    // objects are dropped, so mxLedger* chunks must survive at the top level.
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm-shadow", 0, {
        mxLedgerV: 1,
        mxLedgerKind: "B",
        mxLedgerCycle: 1_755_590_200,
        mxLedgerParts: 2,
        mxLedger0: '{"cy":1755590200,"tg":"gen","qg":"quotes","tr":0,"c":{"uniswap-v3-quo',
        mxLedger1: 'ter-v2@bsc":[1,0,0,0,0]}}',
      }),
      result("skipped_neutral", "solana"),
      result("ok", "tron", 0, { activation: "shadow" }),
    );
    const metadata = JSON.parse(merged.metadata!);

    expect(metadata).toMatchObject({
      mxLedgerV: 1,
      mxLedgerKind: "B",
      mxLedgerCycle: 1_755_590_200,
      mxLedgerParts: 2,
    });
    expect(metadata.mxLedger0).toBe('{"cy":1755590200,"tg":"gen","qg":"quotes","tr":0,"c":{"uniswap-v3-quo');
    expect(metadata.mxLedger1).toBe('ter-v2@bsc":[1,0,0,0,0]}}');
    // The nested lane copies remain untouched.
    expect(metadata.evm.mxLedgerKind).toBe("B");
  });

  it("hoists ledger scalars from the half-hourly shape and keeps the first lane on collision", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm", 0, { mxLedgerV: 1, mxLedgerKind: "B", mxLedgerCycle: 10, mxLedgerParts: 1, mxLedger0: "{}" }),
      result("ok", "solana-shadow", 0, { mxLedgerCycle: 99 }),
      result("skipped_neutral", "tron"),
    );
    const metadata = JSON.parse(merged.metadata!);

    expect(metadata.mxLedgerCycle).toBe(10);
    expect(metadata.mxLedgerParts).toBe(1);
  });

  it("emits no ledger scalars when no lane carries them", () => {
    const merged = mergeMeasuredExecutionResults(
      result("ok", "evm"),
      result("ok", "solana"),
      result("ok", "tron"),
    );
    const metadata = JSON.parse(merged.metadata!);

    expect(Object.keys(metadata).some((key) => key.startsWith("mxLedger"))).toBe(false);
  });
});
