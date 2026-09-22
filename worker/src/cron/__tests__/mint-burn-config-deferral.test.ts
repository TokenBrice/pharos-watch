import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { DatabaseSync } from "node:sqlite";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { fetchConservationBoundaries } from "../../lib/mint-burn-conservation";
import { upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import {
  createMintBurnConfigSummary,
  type MintBurnConfigSummary,
  type SyncMintBurnConfigResult,
} from "../mint-burn/sync-config";
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

vi.mock("../../lib/mint-burn-conservation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mint-burn-conservation")>();
  return { ...actual, fetchConservationBoundaries: vi.fn() };
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
const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

type DeferralRow = {
  config_key: string;
  deferred_until: number;
  reason: string;
  api_errors: number;
  coverage: number | null;
  created_at: number;
};

function readDeferrals(sqlite: DatabaseSync): DeferralRow[] {
  return sqlite.prepare(
    `SELECT config_key, deferred_until, reason, api_errors, coverage, created_at
     FROM mint_burn_config_deferral
     ORDER BY config_key`,
  ).all() as DeferralRow[];
}

function seedDeferral(
  sqlite: DatabaseSync,
  configKey: string,
  deferredUntil: number,
): void {
  sqlite.prepare(
    `INSERT INTO mint_burn_config_deferral
       (config_key, deferred_until, reason, api_errors, coverage, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(configKey, deferredUntil, "seeded", 6, 0.5, NOW_SEC - 60);
}

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
  it("returns only deferrals whose persisted expiry is after now", async () => {
    const { sqlite, db } = fixtures.open();
    seedDeferral(sqlite, "ethereum-0xactive", NOW_SEC + 1);
    seedDeferral(sqlite, "polygon-0xexpired", NOW_SEC);

    await expect(loadDeferredConfigs(db, NOW_SEC)).resolves.toEqual(
      new Set(["ethereum-0xactive"]),
    );
  });
});

describe("deferConfig", () => {
  it("persists the one-hour deferral outcome by semantic column", async () => {
    const { sqlite, db } = fixtures.open();

    await deferConfig(
      db,
      "ethereum-0xaaa",
      NOW_SEC,
      6,
      0.5,
      "api-errors-and-low-coverage",
    );

    expect(readDeferrals(sqlite)).toEqual([{
      config_key: "ethereum-0xaaa",
      deferred_until: NOW_SEC + 3600,
      reason: "api-errors-and-low-coverage",
      api_errors: 6,
      coverage: 0.5,
      created_at: NOW_SEC,
    }]);
  });

  it("persists unknown coverage as null", async () => {
    const { sqlite, db } = fixtures.open();

    await deferConfig(db, "ethereum-0xbbb", NOW_SEC, 7, null, "unknown-coverage");

    expect(readDeferrals(sqlite)[0]).toMatchObject({
      config_key: "ethereum-0xbbb",
      coverage: null,
      reason: "unknown-coverage",
    });
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
    ...createMintBurnConfigSummary(makeConfig(), "ethereum-0xaaaa", "critical", {
      attempted: true,
      scanFrom: 22_000_000,
      scanTo: 22_050_000,
      requestBudgetLimit: 100,
    }),
    advanceReason: "no-safe-frontier",
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
    vi.mocked(fetchConservationBoundaries).mockReset().mockResolvedValue(new Map());
    vi.mocked(upsertMintBurnSyncState).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a deferral for a config with apiErrors=6 and coverage=0.5", async () => {
    const config = makeConfig();
    const { sqlite, db } = fixtures.open();

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

    expect(readDeferrals(sqlite)).toEqual([{
      config_key: "ethereum-0xaaaa",
      deferred_until: NOW_SEC + 3600,
      reason: "api-errors-and-low-coverage",
      api_errors: 6,
      coverage: 0.5,
      created_at: NOW_SEC,
    }]);
  });

  it("skips a deferred config on the next run without invoking syncMintBurnConfig", async () => {
    const config = makeConfig();
    const { sqlite, db } = fixtures.open();
    seedDeferral(sqlite, "ethereum-0xaaaa", NOW_SEC + 600);

    const result = await runMintBurnConfigPhase(makePhaseInput({ db, configs: [config] }));

    expect(vi.mocked(syncMintBurnConfig)).not.toHaveBeenCalled();
    expect(result.contractsProcessed).toBe(0);
    expect(result.contractsSkipped).toBe(1);
    expect(result.configBreakdown[0]!.skippedReason).toBe("deferred");
  });

  it("runs the config again once the deferral has expired", async () => {
    const config = makeConfig();
    const { sqlite, db } = fixtures.open();

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

    expect(readDeferrals(sqlite)).toEqual([]);
  });

  it("does not defer a healthy config with apiErrors below threshold", async () => {
    const config = makeConfig();
    const { sqlite, db } = fixtures.open();

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

    expect(readDeferrals(sqlite)).toEqual([]);
  });

  it("prepares the exact loop ranges and retains completed cursors when a later config aborts", async () => {
    const { db } = fixtures.open();
    const configs = ["gusd-gemini", "usds-sky", "usde-ethena"].map((id) => ({
      ...MINT_BURN_CONFIGS.find((config) => config.stablecoinId === id)!, startBlock: 101,
    }));
    const keys = configs.map((config) => `${config.chain.chainId}-${config.contractAddress}`);
    const args = makePhaseInput({ db, configs });
    args.lastBlocksAfterRun = new Map([[keys[0], 110], [keys[2], 150]]);
    args.chainContexts.get("ethereum")!.chainHead = 160;
    args.maxScanRange = 25;
    const controller = new AbortController();
    args.signal = controller.signal;
    vi.mocked(fetchConservationBoundaries).mockImplementation(async ({ budget }) => {
      budget.count += 3;
      return new Map();
    });
    let index = 0;
    vi.mocked(syncMintBurnConfig).mockImplementation(async (input) => {
      if (index++ === 2) {
        controller.abort(new Error("stop during third scan"));
        throw controller.signal.reason;
      }
      return { summary: makeSummary({ advanceReason: "full-success-empty", advancedTo: input.scanTo, requestBudgetUsed: 2 }),
        apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0, newLastBlock: input.scanTo };
    });
    await expect(runMintBurnConfigPhase(args)).rejects.toThrow("stop during third scan");
    const expected = [
      { key: keys[0], fromBlock: 111, toBlock: 135 },
      { key: keys[1], fromBlock: 101, toBlock: 125 },
      { key: keys[2], fromBlock: 151, toBlock: 160 },
    ];
    expect(vi.mocked(fetchConservationBoundaries).mock.calls[0][0].requests.map(({ key, fromBlock, toBlock }) =>
      ({ key, fromBlock, toBlock }))).toEqual(expected);
    expect(vi.mocked(syncMintBurnConfig).mock.calls.map(([input]) =>
      ({ key: input.key, fromBlock: input.fromBlock, toBlock: input.scanTo }))).toEqual(expected);
    expect(vi.mocked(fetchConservationBoundaries).mock.calls[0][0].deadlineMs).toBe(NOW_SEC * 1000 + 45_000);
    expect(upsertMintBurnSyncState).toHaveBeenNthCalledWith(1, db, keys[0], 135, "monotonic-max");
    expect(upsertMintBurnSyncState).toHaveBeenNthCalledWith(2, db, keys[1], 125, "monotonic-max");
    expect(upsertMintBurnSyncState).toHaveBeenCalledTimes(2);
    expect(args.lastBlocksAfterRun).toEqual(new Map([[keys[0], 135], [keys[1], 125], [keys[2], 150]]));
    expect(args.budget.count).toBe(7);
  });

  it.each(["deferred", "unsupported", "caught-up", "missing-chain"])("excludes %s configs from the pre-pass", async (kind) => {
    const { db, sqlite } = fixtures.open();
    const config = { ...MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!, startBlock: 101 };
    const key = `ethereum-${config.contractAddress}`;
    const args = makePhaseInput({ db, configs: [config] });
    if (kind === "deferred") seedDeferral(sqlite, key, NOW_SEC + 600);
    if (kind === "unsupported") config.decimals = 99;
    if (kind === "caught-up") args.chainContexts.get("ethereum")!.chainHead = 100;
    if (kind === "missing-chain") args.chainContexts.clear();
    vi.mocked(syncMintBurnConfig).mockResolvedValue({
      summary: makeSummary(), apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0,
      atomicRoundtripsDetected: 0, newLastBlock: null,
    });
    await runMintBurnConfigPhase(args);
    expect(vi.mocked(fetchConservationBoundaries).mock.calls[0][0].requests).toEqual([]);
    expect(syncMintBurnConfig).toHaveBeenCalledTimes(kind === "unsupported" ? 1 : 0);
  });

  it("does not pair a changed scan range with the earlier boundary evidence", async () => {
    const { db } = fixtures.open();
    const config = { ...MINT_BURN_CONFIGS.find((item) => item.stablecoinId === "gusd-gemini")!, startBlock: 101 };
    const key = `ethereum-${config.contractAddress}`;
    const args = makePhaseInput({ db, configs: [config] });
    args.chainContexts.get("ethereum")!.chainHead = 200;
    vi.mocked(fetchConservationBoundaries).mockImplementation(async () => {
      args.lastBlocksAfterRun.set(key, 150);
      return new Map();
    });
    vi.mocked(syncMintBurnConfig).mockImplementation(async (input) => {
      expect(input.conservationBoundary).toEqual({ status: "unavailable", reason: "incomplete-log-range" });
      return { summary: makeSummary(), apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0,
        atomicRoundtripsDetected: 0, newLastBlock: null };
    });
    await runMintBurnConfigPhase(args);
    expect(vi.mocked(syncMintBurnConfig).mock.calls[0][0].fromBlock).toBe(151);
  });
});
