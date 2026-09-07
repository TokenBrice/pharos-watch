import { describe, expect, it } from "vitest";

import type { CronResult } from "../../../lib/cron-logger";
import { settleMeasuredExecutionLane } from "../half-hourly-measured-execution";

describe("half-hourly measured execution lane settlement", () => {
  it("passes a settled lane result through unchanged with flat diagnostics", async () => {
    const lane: CronResult = {
      status: "ok",
      itemCount: 3,
      metadata: JSON.stringify({
        measuredCount: 3,
        rpcRequestCount: 7,
      }),
      productivity: { productive: true, reason: "published-measured-execution" },
    };

    const settled = await settleMeasuredExecutionLane("evm", Promise.resolve(lane));

    expect(settled).toBe(lane);
    expect(JSON.parse(settled.metadata!)).toEqual({
      measuredCount: 3,
      rpcRequestCount: 7,
    });
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
