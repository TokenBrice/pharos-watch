import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

vi.mock("../../../cron/yield-coverage-audit", () => ({
  runYieldCoverageAudit: vi.fn(async () => ({ status: "ok" })),
}));

import { runYieldCoverageAudit } from "../../../cron/yield-coverage-audit";
import { runMonthlyYieldAuditSlot } from "../monthly-yield-audit";

describe("runMonthlyYieldAuditSlot", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes runtime chain RPCs into the yield coverage audit", async () => {
    const db = {} as D1Database;
    const chainRpcs = new Map<string, ChainRpcConfig>([
      ["ethereum", {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://rpc.example",
        explorerUrl: "https://etherscan.io",
      }],
    ]);
    const signal = new AbortController().signal;
    const runLeasedCron = vi.fn(async (_job: string, fn) => fn(signal, async () => {}));
    const runtime = makeScheduledRuntime({
      db,
      cron: "0 6 1 * *",
      scheduleKey: "monthlyYieldAudit",
      scheduledTimeMs: null,
      slotStartedAt: 0,
      chainRpcs,
      runLeasedCron: runLeasedCron as ScheduledRuntimeContext["runLeasedCron"],
    });

    await runMonthlyYieldAuditSlot(runtime);

    expect(runLeasedCron).toHaveBeenCalledWith("yield-coverage-audit", expect.any(Function));
    expect(runYieldCoverageAudit).toHaveBeenCalledWith(db, signal, chainRpcs, expect.any(Function));
  });
});
