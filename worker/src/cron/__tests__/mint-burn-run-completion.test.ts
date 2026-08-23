import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeMintBurnRun } from "../mint-burn/run-completion";
import type { MintBurnConfigSummary } from "../mint-burn/sync-config";
import { setMintBurnRunState } from "../mint-burn/run-state";
import { getNullPriceBacklog, healNullPrices } from "../../lib/mint-burn-pipeline/price-heal";
import { sweepRecentRoundtrips } from "../../lib/mint-burn-pipeline/roundtrip-sweep";

vi.mock("../mint-burn/run-state", () => ({
  setMintBurnRunState: vi.fn(),
}));

vi.mock("../../lib/mint-burn-pipeline/price-heal", () => ({
  getNullPriceBacklog: vi.fn(),
  healNullPrices: vi.fn(),
}));

vi.mock("../../lib/mint-burn-pipeline/roundtrip-sweep", () => ({
  sweepRecentRoundtrips: vi.fn(),
}));

function buildRunInput(overrides: { apiErrors?: number; signal?: AbortSignal } = {}): Parameters<typeof completeMintBurnRun>[0] {
  return {
    db: {} as D1Database,
    budget: { limit: 200, count: 7 },
    lane: "critical",
    jobName: "sync-mint-burn",
    chainHeads: new Map([["ethereum", 22_000_000]]),
    resumeConfigKey: null,
    enabledConfigs: [],
    configs: [],
    configsDisabled: 0,
    contractsTotal: 0,
    lastBlocksAfterRun: new Map(),
    runState: { degradedStreak: 0, resumeConfigKey: null },
    runStatePersistenceFailed: false,
    degradeConsecutiveThreshold: 2,
    errorConsecutiveThreshold: 3,
    criticalContractsEnabled: 0,
    phase: {
      rowsRead: 0,
      rowsParsed: 0,
      rowsInserted: 0,
      rowsIgnored: 0,
      rowsDropped: 0,
      contractsProcessed: 0,
      contractsSkipped: 0,
      contractsDeferredExtended: 0,
      runtimeBudgetHit: false,
      apiErrors: overrides.apiErrors ?? 0,
      effectiveBurns: 0,
      bridgeBurns: 0,
      reviewBurns: 0,
      atomicRoundtripsTotal: 0,
      txContextShortfalls: 0,
      bridgeClassificationDeferredRows: 0,
      criticalContractsSatisfied: 0,
      criticalContractsUnsatisfied: 0,
      configBreakdown: [],
      activeProviderDeferrals: new Map(),
    },
    attemptCoverage: {
      stateCacheKey: "mint-burn:attempt-state:sync-mint-burn",
      expectedConfigs: 0,
      attemptedThisRun: 0,
      providerDeferredThisRun: 0,
      neverAttemptedCount: 0,
      staleAttemptCount: 0,
      oldestAttemptAgeSec: null,
      twoCycleCoverageSatisfied: true,
      laggingAttemptSamples: [],
      persistenceFailed: false,
    },
    runDrilldown: {
      cacheKey: "mint-burn:run-detail:sync-mint-burn",
      persistenceFailed: false,
    },
    signal: overrides.signal,
  };
}

describe("completeMintBurnRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps apiErrors separate from validationFailures metadata", async () => {
    vi.mocked(setMintBurnRunState).mockResolvedValue(true);
    vi.mocked(getNullPriceBacklog).mockResolvedValue({ recent: 0, historical: 0 });
    vi.mocked(healNullPrices).mockResolvedValue({ healed: 0, affectedHours: new Map() });
    vi.mocked(sweepRecentRoundtrips).mockResolvedValue({ reclassified: 0, affectedHours: new Map(), saturated: false });

    const result = await completeMintBurnRun(buildRunInput({ apiErrors: 4 }));

    expect(result.metadata.apiErrors).toBe(4);
    expect(result.metadata.validationFailures).toBe(0);
    expect(setMintBurnRunState).toHaveBeenCalledWith(expect.anything(), "sync-mint-burn", 1, null);
  });

  it("warns when the historical NULL-price backlog exceeds the threshold", async () => {
    vi.mocked(setMintBurnRunState).mockResolvedValue(true);
    vi.mocked(getNullPriceBacklog).mockResolvedValue({ recent: 0, historical: 51 });
    vi.mocked(healNullPrices).mockResolvedValue({ healed: 0, affectedHours: new Map() });
    vi.mocked(sweepRecentRoundtrips).mockResolvedValue({ reclassified: 0, affectedHours: new Map(), saturated: false });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await completeMintBurnRun(buildRunInput());
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"historical":51'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when the historical NULL-price backlog is within the threshold", async () => {
    vi.mocked(setMintBurnRunState).mockResolvedValue(true);
    vi.mocked(getNullPriceBacklog).mockResolvedValue({ recent: 0, historical: 50 });
    vi.mocked(healNullPrices).mockResolvedValue({ healed: 0, affectedHours: new Map() });
    vi.mocked(sweepRecentRoundtrips).mockResolvedValue({ reclassified: 0, affectedHours: new Map(), saturated: false });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await completeMintBurnRun(buildRunInput());
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Historical NULL amount_usd backlog"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not persist run state when the run has already been aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("lease lost before completion"));

    await expect(completeMintBurnRun(buildRunInput({ signal: controller.signal })))
      .rejects.toThrow("lease lost before completion");

    expect(setMintBurnRunState).not.toHaveBeenCalled();
    expect(getNullPriceBacklog).not.toHaveBeenCalled();
    expect(healNullPrices).not.toHaveBeenCalled();
    expect(sweepRecentRoundtrips).not.toHaveBeenCalled();
  });

  it("persists a bounded summary instead of all 127 config details", async () => {
    vi.mocked(setMintBurnRunState).mockResolvedValue(true);
    vi.mocked(getNullPriceBacklog).mockResolvedValue({ recent: 0, historical: 0 });
    vi.mocked(healNullPrices).mockResolvedValue({ healed: 0, affectedHours: new Map() });
    vi.mocked(sweepRecentRoundtrips).mockResolvedValue({ reclassified: 0, affectedHours: new Map(), saturated: false });
    const input = buildRunInput();
    input.phase.configBreakdown = Array.from({ length: 127 }, (_, index) => ({
      key: `ethereum-0x${index.toString(16).padStart(40, "0")}`,
      symbol: `COIN${index}`,
      chainId: "ethereum",
      tier: "extended",
      attempted: index < 94,
      skippedReason: index < 94 ? null : "runtime-budget-exhausted",
      scanFrom: 1,
      scanTo: 2,
      advancedTo: index < 94 ? 2 : null,
      maxBlockSeen: 2,
      rowsRead: 0,
      rowsParsed: 0,
      rowsInserted: 0,
      rowsIgnored: 0,
      rowsDropped: 0,
      errors: 0,
      failedEventDefs: [],
      eventCoverage: [],
      coverageFrontier: 2,
      advanceReason: index < 94 ? "full-success-empty" : "no-safe-frontier",
      missingTimestampCount: 0,
      earliestMissingTimestampBlock: null,
      txContextShortfalls: 0,
      bridgeClassificationDeferredRows: 0,
      requestBudgetLimit: 25,
      requestBudgetUsed: index < 94 ? 1 : 0,
    } satisfies MintBurnConfigSummary));
    input.attemptCoverage = {
      ...input.attemptCoverage,
      expectedConfigs: 127,
      attemptedThisRun: 94,
      neverAttemptedCount: 33,
    };

    const result = await completeMintBurnRun(input);
    const serialized = JSON.stringify(result.metadata);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(64 * 1024);
    expect(result.metadata).not.toHaveProperty("configBreakdown");
    expect(result.metadata.configBreakdownSummary).toMatchObject({ total: 127, attempted: 94, skipped: 33 });
    expect(result.metadata.configSamples).toHaveLength(12);
    expect(result.metadata.runDrilldownCacheKey).toBe("mint-burn:run-detail:sync-mint-burn");
  });
});
