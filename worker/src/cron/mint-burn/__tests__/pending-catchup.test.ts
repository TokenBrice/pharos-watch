import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMintBurnConfig } from "../../../test-helpers/__shared/mint-burn-config";
import { fetchConservationBoundaries } from "../../../lib/mint-burn-conservation";
import { createMintBurnConfigSummary } from "../sync-config";
import { mintBurnScanRequestFloor, syncMintBurnConfigWithRetries } from "../scan-with-retry";
import { configKey, runMintBurnConfigPhase } from "../run-configs";
import type * as ScanRetryModule from "../scan-with-retry";

vi.mock("../scan-with-retry", async (importOriginal) => ({
  ...await importOriginal<typeof ScanRetryModule>(), syncMintBurnConfigWithRetries: vi.fn(),
}));
vi.mock("../../../lib/mint-burn-conservation", () => ({
  fetchConservationBoundaries: vi.fn(),
  conservationOnlyEventDefsFor: () => [],
  getMintBurnConservationEligibility: () => ({ supported: true }),
  MINT_BURN_CONSERVATION_PREPASS_MAX_MS: 45_000,
}));
vi.mock("../run-state", () => ({
  loadActiveConfigDeferrals: async () => new Map(),
  shouldDeferConfig: () => false,
  deferConfig: vi.fn(),
}));

const NOW = 1_800_000_000;
const events = ["mint", "burn"].map((direction, index) => ({
  signature: `${direction}(uint256)`, topicHash: `0x${String(index + 1).repeat(64)}`,
  direction: direction as "mint" | "burn", amountEncoding: "first-data-uint256" as const,
}));
const admitted = makeMintBurnConfig({ chain: { chainId: "synthetic" }, events,
  asset: { stablecoinId: "synthetic-coin", startBlock: 1, contractAddress: `0x${"1".repeat(40)}`, tier: "critical" } });
const pending = { ...admitted, contractAddress: `0x${"2".repeat(40)}` };
const order: string[] = [];

function input(): Parameters<typeof runMintBurnConfigPhase>[0] {
  const endpoint = { url: "https://synthetic.example", operator: "dwellir" as const, keyed: true,
    position: "registry" as const, stateHistory: "archive" as const, logsHistory: "full" as const, maxLogBlockSpan: 10_000 };
  return {
    db: {} as D1Database, configs: [pending, admitted], pendingAdmissionKeys: new Set([configKey(pending)]),
    lane: "all", jobName: "sync-mint-burn", budget: { count: 1, limit: 200 }, runTimestamp: NOW,
    chainContexts: new Map([["synthetic", { chainHead: 2_592_000, rpcEndpoints: [endpoint],
      endpointHeads: new Map(), chainTimestampCache: new Map(), txContextCache: new Map() }]]),
    priceContext: { priceObservations: new Map(), priceHistory: new Map() }, lastBlocksAfterRun: new Map(),
    pendingCursorUpdates: new Map(), pendingScanCoverage: new Map(), maxScanRange: 50_000,
    criticalConfigBudgetLimit: 60, criticalBridgeConfigBudgetLimit: 150, extendedConfigBudgetLimit: 25,
    affectedHours: new Map(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  order.length = 0;
  vi.mocked(fetchConservationBoundaries).mockReset().mockImplementation(async ({ requests, budget }) => {
    if (requests.length) {
      order.push(`boundaries:${requests.map(({ key }) => key).join(",")}`);
      budget.count += Math.min(3, budget.limit - budget.count);
    }
    return new Map();
  });
  vi.mocked(syncMintBurnConfigWithRetries).mockReset().mockImplementation(async (scan) => {
    order.push(`scan:${scan.key}`);
    const used = mintBurnScanRequestFloor(scan);
    expect(used).toBeLessThanOrEqual(scan.configBudgetLimit);
    return {
      summary: { ...createMintBurnConfigSummary(scan.config, scan.key, scan.tier, {
        attempted: true, scanFrom: scan.fromBlock, scanTo: scan.scanTo, requestBudgetLimit: scan.configBudgetLimit,
      }), advanceReason: "full-success-empty", advancedTo: scan.scanTo, requestBudgetUsed: used },
      apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0,
      newLastBlock: scan.scanTo,
      scanCoverage: { configKey: scan.key, configFingerprint: "synthetic", chainId: scan.config.chain.chainId,
        fromBlock: scan.fromBlock, toBlock: scan.scanTo, fromTimestamp: NOW - 100, toTimestamp: NOW - 1,
        finalizedBlock: scan.chainHead, acceptedAt: NOW },
    };
  });
});
afterEach(() => vi.useRealTimers());

describe("pending-admission catch-up budget", () => {
  it("serves admitted scans before pending conservation, with larger bounded pending ranges", async () => {
    const args = input();
    const result = await runMintBurnConfigPhase(args);
    expect(order).toEqual([
      `boundaries:${configKey(admitted)}`, `scan:${configKey(admitted)}`,
      `boundaries:${configKey(pending)}`, `scan:${configKey(pending)}`,
    ]);
    expect(vi.mocked(syncMintBurnConfigWithRetries).mock.calls.map(([scan]) => scan.scanTo - scan.fromBlock + 1))
      .toEqual([50_000, 270_000]);
    expect(vi.mocked(syncMintBurnConfigWithRetries).mock.calls.map(([scan]) => scan.deadlineMs))
      .toEqual([(NOW + 9 * 60) * 1000, (NOW + 6 * 60) * 1000]);
    expect(result.configBreakdown[1]).toMatchObject({ requestBudgetLimit: 60, requestBudgetUsed: 59 });
    expect(args.budget.count).toBe(75);
    expect(result.criticalContractsSatisfied).toBe(1);
    expect(result.criticalContractsUnsatisfied).toBe(0);
    expect(args.pendingCursorUpdates.get(configKey(pending))).toBe(270_000);
    expect(args.pendingScanCoverage?.get(configKey(pending))?.toBlock).toBe(270_000);
  });

  it("leaves pending work unstarted when admitted scans exhaust the allowance", async () => {
    const args = input();
    args.budget.count = 184;
    const result = await runMintBurnConfigPhase(args);
    expect(order).toEqual([`boundaries:${configKey(admitted)}`, `scan:${configKey(admitted)}`]);
    expect(result.configBreakdown[1]).toMatchObject({ attempted: false, skippedReason: "global-budget-exhausted" });
    expect(result.criticalContractsUnsatisfied).toBe(0);
    expect(args.budget.count).toBe(199);
  });

  it("does not degrade admitted coverage when only pending work misses the deadline", async () => {
    const args = input();
    args.preparePendingConfigs = vi.fn();
    args.reportProgress = async (progress) => {
      if (progress.metadata?.configKey === configKey(admitted)) vi.setSystemTime((NOW + 5 * 60 + 30) * 1000);
    };
    const result = await runMintBurnConfigPhase(args);
    expect(result.configBreakdown[1]).toMatchObject({ attempted: false, skippedReason: "runtime-budget-exhausted" });
    expect(result.runtimeBudgetHit).toBe(true);
    expect(result.criticalContractsUnsatisfied).toBe(0);
    expect(args.preparePendingConfigs).not.toHaveBeenCalled();
    expect(args.pendingCursorUpdates.get(configKey(admitted))).toBe(50_000);
  });

  it("holds pending scans after slow head preparation reaches its earlier deadline", async () => {
    const args = input();
    args.preparePendingConfigs = async (_budget, deadlineMs) => {
      expect(deadlineMs).toBe((NOW + 6 * 60) * 1000);
      vi.setSystemTime(deadlineMs);
    };
    const result = await runMintBurnConfigPhase(args);
    expect(result.configBreakdown[1]).toMatchObject({ attempted: false, skippedReason: "runtime-budget-exhausted" });
    expect(syncMintBurnConfigWithRetries).toHaveBeenCalledTimes(1);
    expect(args.pendingCursorUpdates.get(configKey(admitted))).toBe(50_000);
    expect(result.criticalContractsUnsatisfied).toBe(0);
  });

  it("keeps the extended per-config cap, including its deferred conservation reads", async () => {
    const args = input();
    const extended = { ...pending, tier: "extended" as const };
    args.configs = [extended];
    args.lane = "extended";
    const result = await runMintBurnConfigPhase(args);
    expect(result.configBreakdown[0]).toMatchObject({ requestBudgetLimit: 25, requestBudgetUsed: 25 });
    expect(args.pendingCursorUpdates.get(configKey(pending))).toBe(100_000);
    expect(args.budget.count).toBe(26);
  });

  it("catches a moving 90-day frontier in ten half-hour runs without starving the admitted leg", async () => {
    const args = input();
    args.lastBlocksAfterRun.set(configKey(admitted), 2_591_600);
    let runs = 0;
    do {
      args.budget.count = 1;
      await runMintBurnConfigPhase(args);
      for (const [key, block] of args.pendingCursorUpdates) args.lastBlocksAfterRun.set(key, block);
      const head = args.chainContexts.get("synthetic")!.chainHead!;
      expect(args.lastBlocksAfterRun.get(configKey(admitted))).toBe(head);
      expect(args.budget.count).toBeLessThanOrEqual(200);
      runs++;
      if (args.lastBlocksAfterRun.get(configKey(pending)) === head) break;
      args.chainContexts.get("synthetic")!.chainHead = head + 600;
    } while (runs < 12);
    expect(runs).toBe(10);
    expect(args.lastBlocksAfterRun.get(configKey(pending))).toBe(args.chainContexts.get("synthetic")!.chainHead);
  });

  it("prepares pending chain heads only after admitted scans, charging the phase budget", async () => {
    const args = input();
    const remotePending = { ...pending, chain: { ...pending.chain, chainId: "pending-synthetic" } };
    args.configs = [remotePending, admitted];
    args.pendingAdmissionKeys = new Set([configKey(remotePending)]);
    args.preparePendingConfigs = async (budget) => {
      expect(budget).toBe(args.budget);
      order.push("pending-head");
      budget.count++;
      args.chainContexts.set("pending-synthetic", { ...args.chainContexts.get("synthetic")! });
    };
    await runMintBurnConfigPhase(args);
    expect(order).toEqual([
      `boundaries:${configKey(admitted)}`, `scan:${configKey(admitted)}`, "pending-head",
      `boundaries:${configKey(remotePending)}`, `scan:${configKey(remotePending)}`,
    ]);
    expect(args.budget.count).toBe(76);
  });

  it("retains pending API failures without charging admitted health", async () => {
    const scan = vi.mocked(syncMintBurnConfigWithRetries).getMockImplementation()!;
    vi.mocked(syncMintBurnConfigWithRetries).mockImplementation(async (request) => {
      const result = await scan(request);
      return request.key === configKey(pending) ? { ...result, apiErrors: 3, newLastBlock: null,
        summary: { ...result.summary, errors: 3, advanceReason: "scan-coverage-unproven" } } : result;
    });
    const result = await runMintBurnConfigPhase(input());
    expect(result.apiErrors).toBe(3);
    expect(result.admittedApiErrors).toBe(0);
    expect(result.criticalContractsUnsatisfied).toBe(0);
  });

  it.each(["scan", "conservation"])("isolates a pending %s exception and preserves staged admitted progress", async (stage) => {
    const args = input();
    const sibling = { ...pending, contractAddress: `0x${"3".repeat(40)}` };
    args.configs = [pending, sibling, admitted];
    args.pendingAdmissionKeys = new Set([configKey(pending), configKey(sibling)]);
    const scan = vi.mocked(syncMintBurnConfigWithRetries).getMockImplementation()!;
    const boundaries = vi.mocked(fetchConservationBoundaries).getMockImplementation()!;
    vi.mocked(syncMintBurnConfigWithRetries).mockImplementation(async (request) => {
      if (stage === "scan" && request.key === configKey(pending)) {
        request.affectedHours.set("partial", { stablecoinId: "synthetic-coin", chainId: "synthetic", hourTs: NOW - 3600 });
        throw new Error("synthetic pending scan failed after a partial write");
      }
      return scan(request);
    });
    vi.mocked(fetchConservationBoundaries).mockImplementation(async (request) => {
      if (stage === "conservation" && request.requests[0]?.key === configKey(pending)) {
        request.budget.count++;
        throw new Error("synthetic pending conservation failed");
      }
      return boundaries(request);
    });
    const result = await runMintBurnConfigPhase(args);
    expect(result.configBreakdown[1]).toMatchObject({
      key: configKey(pending), attempted: true, errors: 1, failedEventDefs: ["pending-scan-exception"],
      advanceReason: "scan-coverage-unproven", advancedTo: null, requestBudgetLimit: 60, requestBudgetUsed: 60,
    });
    expect(args.budget.count).toBe(135);
    expect(result.criticalContractsSatisfied).toBe(1);
    expect(result.criticalContractsUnsatisfied).toBe(0);
    expect(result.admittedApiErrors).toBe(0);
    expect(args.pendingCursorUpdates.has(configKey(pending))).toBe(false);
    expect(args.pendingScanCoverage?.has(configKey(pending))).toBe(false);
    expect(args.pendingCursorUpdates.get(configKey(admitted))).toBe(50_000);
    expect(args.pendingCursorUpdates.get(configKey(sibling))).toBe(270_000);
    expect(args.lastBlocksAfterRun.size).toBe(0);
    expect(args.affectedHours.has("partial")).toBe(stage === "scan");
  });

  it("still throws an admitted scan exception", async () => {
    vi.mocked(syncMintBurnConfigWithRetries).mockRejectedValue(new Error("admitted scan failed"));
    await expect(runMintBurnConfigPhase(input())).rejects.toThrow("admitted scan failed");
    expect(syncMintBurnConfigWithRetries).toHaveBeenCalledTimes(1);
  });

  it.each(["signal", "abort-error"])("preserves %s cancellation during pending scans", async (kind) => {
    const args = input();
    const controller = new AbortController();
    args.signal = controller.signal;
    const scan = vi.mocked(syncMintBurnConfigWithRetries).getMockImplementation()!;
    const stop = new Error("stop pending work");
    if (kind === "abort-error") stop.name = "AbortError";
    vi.mocked(syncMintBurnConfigWithRetries).mockImplementation(async (request) => {
      if (request.key === configKey(pending)) {
        if (kind === "signal") controller.abort(stop);
        throw stop;
      }
      return scan(request);
    });
    await expect(runMintBurnConfigPhase(args)).rejects.toBe(stop);
  });

  it("isolates pending chain preparation exceptions and exhausts their remaining allowance", async () => {
    const args = input();
    args.preparePendingConfigs = async (budget) => {
      budget.count++;
      throw new Error("synthetic pending head failed");
    };
    const result = await runMintBurnConfigPhase(args);
    expect(result.configBreakdown[1]).toMatchObject({ attempted: false, errors: 1, skippedReason: "pending-chain-context-failed" });
    expect(result.criticalContractsSatisfied).toBe(1);
    expect(result.criticalContractsUnsatisfied).toBe(0);
    expect(args.budget.count).toBe(args.budget.limit);
    expect(args.pendingCursorUpdates.get(configKey(admitted))).toBe(50_000);
    expect(args.pendingCursorUpdates.has(configKey(pending))).toBe(false);
    expect(syncMintBurnConfigWithRetries).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation during pending chain preparation", async () => {
    const args = input();
    const controller = new AbortController();
    args.signal = controller.signal;
    const stop = new Error("stop pending preparation");
    args.preparePendingConfigs = async () => {
      controller.abort(stop);
      throw stop;
    };
    await expect(runMintBurnConfigPhase(args)).rejects.toBe(stop);
  });
});
