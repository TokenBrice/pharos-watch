import { describe, expect, it } from "vitest";

import type { CronResult } from "../../../lib/cron-logger";
import { settleMeasuredExecutionLane } from "../half-hourly-measured-execution";

describe("half-hourly measured execution lane settlement", () => {
  it("passes a settled lane result through unchanged, keeping ledger scalars top-level", async () => {
    // Producer history keeps only top-level scalar metadata, so the durable
    // mxLedger* evidence-ledger chunks (Record B) must stay flat on the lane
    // result the handler returns to recordProducerOutcome.
    const lane: CronResult = {
      status: "ok",
      itemCount: 3,
      metadata: JSON.stringify({
        measuredCount: 3,
        mxLedgerV: 1,
        mxLedgerKind: "B",
        mxLedgerCycle: 1_755_590_200,
        mxLedgerParts: 2,
        mxLedger0: '{"cy":1755590200,"tg":"gen","qg":"quotes","tr":0,"c":{"uniswap-v3-quo',
        mxLedger1: 'ter-v2@bsc":[1,0,0,0,0]}}',
      }),
      productivity: { productive: true, reason: "published-measured-execution" },
    };

    const settled = await settleMeasuredExecutionLane("evm", Promise.resolve(lane));

    expect(settled).toBe(lane);
    const metadata = JSON.parse(settled.metadata!);
    expect(metadata).toMatchObject({
      mxLedgerV: 1,
      mxLedgerKind: "B",
      mxLedgerCycle: 1_755_590_200,
      mxLedgerParts: 2,
    });
    expect(metadata.mxLedger0).toBe('{"cy":1755590200,"tg":"gen","qg":"quotes","tr":0,"c":{"uniswap-v3-quo');
    expect(metadata.mxLedger1).toBe('ter-v2@bsc":[1,0,0,0,0]}}');
  });

  it("preserves degraded and error lane statuses", async () => {
    const degraded: CronResult = {
      status: "degraded",
      itemCount: 1,
      metadata: JSON.stringify({ attemptedFailureCount: 2 }),
      productivity: { productive: true, reason: "published-measured-execution" },
    };
    expect((await settleMeasuredExecutionLane("evm", Promise.resolve(degraded))).status).toBe("degraded");
  });

  it("converts a lane invocation rejection into a terminal error result", async () => {
    const settled = await settleMeasuredExecutionLane(
      "evm-shadow",
      Promise.reject(new Error("rpc unavailable")),
    );

    expect(settled.status).toBe("error");
    expect(settled.itemCount).toBe(0);
    expect(JSON.parse(settled.metadata!)).toEqual({
      lane: "evm-shadow",
      error: "rpc unavailable",
    });
    expect(settled.productivity).toEqual({
      productive: false,
      reason: "evm-shadow-measured-execution-failed",
    });
  });
});
