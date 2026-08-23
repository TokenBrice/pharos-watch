import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScheduledRuntimeContext } from "../context";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

vi.mock("../../../cron/sync-yield-supplemental", () => ({
  syncYieldSupplemental: vi.fn(async () => ({ status: "ok" })),
}));

import { syncYieldSupplemental } from "../../../cron/sync-yield-supplemental";
import { runYieldSupplementalSlot } from "../yield-supplemental";

function buildRuntime(env: Partial<ScheduledRuntimeContext["env"]> = {}): {
  runtime: ScheduledRuntimeContext;
  signal: AbortSignal;
  reportProgress: ReturnType<typeof vi.fn>;
} {
  const db = {} as D1Database;
  const signal = new AbortController().signal;
  const reportProgress = vi.fn(async () => {});
  const chainRpcs = new Map<string, ChainRpcConfig>([
    [
      "ethereum",
      {
        chainId: "ethereum",
        chainName: "Ethereum",
        type: "evm",
        rpcUrl: "https://rpc.example",
        explorerUrl: "https://etherscan.io",
      },
    ],
  ]);
  const runLeasedCron = vi.fn(async (_job: string, fn) => fn(signal, reportProgress));
  return {
    runtime: makeScheduledRuntime({
      db,
      env: { ...env } as ScheduledRuntimeContext["env"],
      cron: "25 */4 * * *",
      scheduleKey: "fourHourlyYieldSupplemental",
      scheduledTimeMs: null,
      slotStartedAt: 0,
      chainRpcs,
      runLeasedCron: runLeasedCron as ScheduledRuntimeContext["runLeasedCron"],
    }),
    signal,
    reportProgress,
  };
}

describe("runYieldSupplementalSlot", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes disabled vaults.fyi config by default", async () => {
    const { runtime, signal, reportProgress } = buildRuntime();

    await runYieldSupplementalSlot(runtime);

    expect(syncYieldSupplemental).toHaveBeenCalledWith(runtime.db, signal, runtime.chainRpcs, reportProgress, {
      enabled: false,
      disabledReason: "not-enabled",
      apiKey: null,
      rankableVaults: [],
      maxCreditsPerRun: null,
      maxCreditsPerMonth: null,
      maxPagesPerRun: null,
    });
  });

  it("passes enabled vaults.fyi config when explicitly configured", async () => {
    const { runtime, signal, reportProgress } = buildRuntime({
      VAULTS_FYI_ENABLED: "true",
      VAULTS_FYI_API_KEY: "vaults-key",
      VAULTS_FYI_RANKABLE_VAULTS: "base:vault-a",
      VAULTS_FYI_MAX_CREDITS_PER_RUN: "25",
    });

    await runYieldSupplementalSlot(runtime);

    expect(syncYieldSupplemental).toHaveBeenCalledWith(runtime.db, signal, runtime.chainRpcs, reportProgress, {
      enabled: true,
      disabledReason: null,
      apiKey: "vaults-key",
      rankableVaults: ["base:vault-a"],
      maxCreditsPerRun: 25,
      maxCreditsPerMonth: null,
      maxPagesPerRun: null,
    });
  });
});
