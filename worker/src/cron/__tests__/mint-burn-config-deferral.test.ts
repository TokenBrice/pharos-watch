import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import type { MintBurnConfigSummary, SyncMintBurnConfigResult } from "../mint-burn/sync-config";
import {
  deferConfig,
  loadDeferredConfigs,
  shouldDeferConfig,
} from "../mint-burn/run-state";

vi.mock("../mint-burn/sync-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mint-burn/sync-config")>();
  return {
    ...actual,
    syncMintBurnConfig: vi.fn(),
  };
});

vi.mock("../../lib/mint-burn-pipeline/sync-state", () => ({
  mintBurnConfigKey: (c: MintBurnContractConfig) => `${c.chain.chainId}-${c.contractAddress}`,
  upsertMintBurnSyncState: vi.fn(async () => {}),
}));

vi.mock("../../lib/evm-logs", () => ({
  budgetExhausted: vi.fn((b: { count: number; limit: number }) => b.count >= b.limit),
  createBudget: vi.fn((limit = 200) => ({ count: 0, limit })),
}));

import { runMintBurnConfigPhase } from "../mint-burn/run-configs";
import { syncMintBurnConfig } from "../mint-burn/sync-config";

const NOW_SEC = 1_750_000_000;

describe("shouldDeferConfig", () => {
  it("does not defer when apiErrors is at or below the threshold", () => {
    expect(shouldDeferConfig(0, 0.0)).toBe(false);
    expect(shouldDeferConfig(5, 0.0)).toBe(false);
    expect(shouldDeferConfig(5, null)).toBe(false);
  });

  it("defers when apiErrors exceeds the threshold and coverage is null (unknown)", () => {
    expect(shouldDeferConfig(6, null)).toBe(true);
    expect(shouldDeferConfig(100, null)).toBe(true);
  });

  it("defers when apiErrors exceeds the threshold and coverage is below the ceiling", () => {
    expect(shouldDeferConfig(6, 0.0)).toBe(true);
    expect(shouldDeferConfig(6, 0.5)).toBe(true);
    expect(shouldDeferConfig(6, 0.79)).toBe(true);
  });

  it("does not defer when apiErrors exceeds the threshold but coverage is healthy", () => {
    expect(shouldDeferConfig(6, 0.8)).toBe(false);
    expect(shouldDeferConfig(6, 1.0)).toBe(false);
  });
});

describe("loadDeferredConfigs", () => {
  it("returns active deferrals (deferred_until > nowSec)", async () => {
    const db = mockD1([
      {
        match: "FROM mint_burn_config_deferral",
        rows: [
          { config_key: "ethereum-0xaaa" },
          { config_key: "polygon-0xbbb" },
        ],
      },
    ]);

    const deferred = await loadDeferredConfigs(db, NOW_SEC);
    expect(deferred).toEqual(new Set(["ethereum-0xaaa", "polygon-0xbbb"]));
  });

  it("returns an empty set when no rows match", async () => {
    const db = mockD1([{ match: "FROM mint_burn_config_deferral", rows: [] }]);
    const deferred = await loadDeferredConfigs(db, NOW_SEC);
    expect(deferred.size).toBe(0);
  });

  it("binds nowSec so expired deferrals are filtered by the SQL WHERE clause", async () => {
    const db = mockD1([{ match: "FROM mint_burn_config_deferral", rows: [] }]);
    await loadDeferredConfigs(db, NOW_SEC);

    const history = (
      db as ReturnType<typeof mockD1> & {
        getHistory(): Array<{ sql: string; binds: unknown[] }>;
      }
    ).getHistory();
    const entry = history.find((e) => e.sql.includes("FROM mint_burn_config_deferral"));
    expect(entry).toBeDefined();
    expect(entry!.sql).toMatch(/deferred_until\s*>\s*\?/);
    expect(entry!.binds).toEqual([NOW_SEC]);
  });
});

describe("deferConfig", () => {
  it("writes deferred_until = nowSec + 3600 via INSERT OR REPLACE", async () => {
    const db = mockD1([{ match: "mint_burn_config_deferral", rows: [] }]);

    await deferConfig(
      db,
      "ethereum-0xaaa",
      NOW_SEC,
      6,
      0.5,
      "api-errors-and-low-coverage",
    );

    const history = (
      db as ReturnType<typeof mockD1> & {
        getHistory(): Array<{ sql: string; binds: unknown[] }>;
      }
    ).getHistory();
    const writes = history.filter((e) => e.sql.includes("mint_burn_config_deferral"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).toMatch(/INSERT\s+OR\s+REPLACE/i);
    expect(writes[0]!.binds).toEqual([
      "ethereum-0xaaa",
      NOW_SEC + 3600,
      "api-errors-and-low-coverage",
      6,
      0.5,
      NOW_SEC,
    ]);
  });

  it("accepts null coverage for unknown-coverage deferrals", async () => {
    const db = mockD1([{ match: "mint_burn_config_deferral", rows: [] }]);

    await deferConfig(db, "ethereum-0xbbb", NOW_SEC, 7, null, "unknown-coverage");

    const history = (
      db as ReturnType<typeof mockD1> & {
        getHistory(): Array<{ sql: string; binds: unknown[] }>;
      }
    ).getHistory();
    const writes = history.filter((e) => e.sql.includes("mint_burn_config_deferral"));
    expect(writes[0]!.binds[4]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orchestrator integration tests
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<MintBurnContractConfig>): MintBurnContractConfig {
  return {
    chain: {
      chainId: "ethereum",
      chainName: "Ethereum",
      evmChainId: 1,
      explorerUrl: "https://etherscan.io",
      type: "evm",
    },
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    contractAddress: "0xaaaa",
    decimals: 6,
    dustThreshold: 10_000,
    startBlock: 21_900_000,
    adapterKind: "mixed",
    startBlockSource: "reviewed-contract-specific",
    startBlockConfidence: "high",
    tier: "critical",
    events: [],
    ...overrides,
  } as MintBurnContractConfig;
}

function makeSummary(overrides?: Partial<MintBurnConfigSummary>): MintBurnConfigSummary {
  return {
    key: "ethereum-0xaaaa",
    symbol: "USDT",
    chainId: "ethereum",
    tier: "critical",
    attempted: true,
    skippedReason: null,
    scanFrom: 22_000_000,
    scanTo: 22_050_000,
    advancedTo: null,
    maxBlockSeen: 0,
    rowsRead: 0,
    rowsParsed: 0,
    rowsInserted: 0,
    rowsIgnored: 0,
    rowsDropped: 0,
    errors: 0,
    failedEventDefs: [],
    eventCoverage: [],
    coverageFrontier: null,
    advanceReason: "no-safe-frontier",
    missingTimestampCount: 0,
    earliestMissingTimestampBlock: null,
    txContextShortfalls: 0,
    bridgeClassificationDeferredRows: 0,
    requestBudgetLimit: 100,
    requestBudgetUsed: 10,
    ...overrides,
  };
}

function makeChainContext() {
  return new Map([
    ["ethereum", {
      chainHead: 22_050_000,
      alchemyUrl: "https://eth.example",
      chainTimestampCache: new Map<number, number>(),
      txContextCache: new Map(),
    }],
  ]);
}

function makePhaseInput(opts: {
  db: D1Database;
  configs: MintBurnContractConfig[];
}): Parameters<typeof runMintBurnConfigPhase>[0] {
  return {
    db: opts.db,
    configs: opts.configs,
    lane: "all",
    jobName: "sync-mint-burn",
    budget: { limit: 200, count: 0 },
    chainContexts: makeChainContext(),
    runTimestamp: NOW_SEC,
    priceContext: { prices: new Map(), priceHistory: new Map() },
    lastBlocksAfterRun: new Map([["ethereum-0xaaaa", 22_000_000]]),
    maxScanRange: 50_000,
    criticalConfigBudgetLimit: 100,
    extendedConfigBudgetLimit: 50,
    evmSafetyMarginBlocks: 12,
    affectedHours: new Map(),
  };
}

describe("runMintBurnConfigPhase deferral integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
    vi.mocked(syncMintBurnConfig).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a deferral for a config with apiErrors=6 and coverage=0.5", async () => {
    const config = makeConfig();
    const db = mockD1([{ match: "FROM mint_burn_config_deferral", rows: [] }]);

    vi.mocked(syncMintBurnConfig).mockImplementation(async () => ({
      summary: makeSummary({
        eventCoverage: [
          { eventDef: "a", status: "ok", complete: true, scannedToBlock: 22_050_000, rowsRead: 0 },
          { eventDef: "b", status: "fetch-failed", complete: false, scannedToBlock: 22_000_000, rowsRead: 0 },
        ],
      }),
      apiErrors: 6,
      effectiveBurns: 0,
      bridgeBurns: 0,
      reviewBurns: 0,
      atomicRoundtripsDetected: 0,
      newLastBlock: null,
    } satisfies SyncMintBurnConfigResult));

    await runMintBurnConfigPhase(makePhaseInput({ db, configs: [config] }));

    const history = (
      db as ReturnType<typeof mockD1> & {
        getHistory(): Array<{ sql: string; binds: unknown[] }>;
      }
    ).getHistory();
    const inserts = history.filter((e) =>
      e.sql.includes("INSERT OR REPLACE INTO mint_burn_config_deferral"),
    );
    expect(inserts).toHaveLength(1);
    const binds = inserts[0]!.binds;
    expect(binds[0]).toBe("ethereum-0xaaaa");
    expect(binds[1]).toBe(NOW_SEC + 3600);
    expect(binds[2]).toBe("api-errors-and-low-coverage");
    expect(binds[3]).toBe(6);
    expect(binds[4]).toBe(0.5);
    expect(binds[5]).toBe(NOW_SEC);
  });

  it("skips a deferred config on the next run without invoking syncMintBurnConfig", async () => {
    const config = makeConfig();
    const db = mockD1([
      {
        match: "FROM mint_burn_config_deferral",
        rows: [{ config_key: "ethereum-0xaaaa" }],
      },
    ]);

    const result = await runMintBurnConfigPhase(makePhaseInput({ db, configs: [config] }));

    expect(vi.mocked(syncMintBurnConfig)).not.toHaveBeenCalled();
    expect(result.contractsProcessed).toBe(0);
    expect(result.contractsSkipped).toBe(1);
    expect(result.configBreakdown[0]!.skippedReason).toBe("deferred");
  });

  it("runs the config again once the deferral has expired", async () => {
    const config = makeConfig();
    // loadDeferredConfigs filters by deferred_until > nowSec — mock returns empty.
    const db = mockD1([{ match: "FROM mint_burn_config_deferral", rows: [] }]);

    vi.mocked(syncMintBurnConfig).mockResolvedValue({
      summary: makeSummary({
        eventCoverage: [
          { eventDef: "a", status: "ok", complete: true, scannedToBlock: 22_050_000, rowsRead: 0 },
        ],
        advanceReason: "full-success-empty",
        advancedTo: 22_049_988,
      }),
      apiErrors: 0,
      effectiveBurns: 0,
      bridgeBurns: 0,
      reviewBurns: 0,
      atomicRoundtripsDetected: 0,
      newLastBlock: 22_049_988,
    } satisfies SyncMintBurnConfigResult);

    const result = await runMintBurnConfigPhase(makePhaseInput({ db, configs: [config] }));

    expect(vi.mocked(syncMintBurnConfig)).toHaveBeenCalledTimes(1);
    expect(result.contractsProcessed).toBe(1);
    expect(result.contractsSkipped).toBe(0);

    const history = (
      db as ReturnType<typeof mockD1> & {
        getHistory(): Array<{ sql: string; binds: unknown[] }>;
      }
    ).getHistory();
    const inserts = history.filter((e) =>
      e.sql.includes("INSERT OR REPLACE INTO mint_burn_config_deferral"),
    );
    expect(inserts).toHaveLength(0);

    const loadQuery = history.find((e) => e.sql.includes("FROM mint_burn_config_deferral"));
    expect(loadQuery!.binds[0]).toBe(NOW_SEC);
  });

  it("does not defer a healthy config with apiErrors below threshold", async () => {
    const config = makeConfig();
    const db = mockD1([{ match: "FROM mint_burn_config_deferral", rows: [] }]);

    vi.mocked(syncMintBurnConfig).mockResolvedValue({
      summary: makeSummary({
        eventCoverage: [
          { eventDef: "a", status: "fetch-failed", complete: false, scannedToBlock: 22_000_000, rowsRead: 0 },
        ],
      }),
      apiErrors: 5,
      effectiveBurns: 0,
      bridgeBurns: 0,
      reviewBurns: 0,
      atomicRoundtripsDetected: 0,
      newLastBlock: null,
    } satisfies SyncMintBurnConfigResult);

    await runMintBurnConfigPhase(makePhaseInput({ db, configs: [config] }));

    const history = (
      db as ReturnType<typeof mockD1> & {
        getHistory(): Array<{ sql: string; binds: unknown[] }>;
      }
    ).getHistory();
    const inserts = history.filter((e) =>
      e.sql.includes("INSERT OR REPLACE INTO mint_burn_config_deferral"),
    );
    expect(inserts).toHaveLength(0);
  });
});
