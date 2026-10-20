import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintBurnAlchemyEndpoint } from "../../lib/mint-burn-pipeline/rpc";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { DatabaseSync } from "node:sqlite";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { conservationOnlyEventDefsFor, fetchConservationBoundaries } from "../../lib/mint-burn-conservation";
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
  resolveMintBurnResumeConfigKey,
  resolveRotatedConfigs,
} from "../mint-burn/run-state";
import type * as ScanRetryModule from "../mint-burn/scan-with-retry";

vi.mock("../mint-burn/scan-with-retry", async (importOriginal) => ({
  ...await importOriginal<typeof ScanRetryModule>(),
  syncMintBurnConfigWithRetries: vi.fn(),
}));

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
import { mintBurnScanRequestFloor, syncMintBurnConfigWithRetries as syncMintBurnConfig } from "../mint-burn/scan-with-retry";

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
      rpcEndpoints: [mintBurnAlchemyEndpoint("https://eth.example")],
      endpointHeads: new Map<string, number>(),
      chainTimestampCache: new Map<string, number>(),
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
    priceContext: { priceObservations: new Map(), priceHistory: new Map() },
    lastBlocksAfterRun: new Map([["ethereum-0xaaaa", 22_000_000]]),
    pendingCursorUpdates: new Map(),
    maxScanRange: 50_000,
    criticalConfigBudgetLimit: 100,
    extendedConfigBudgetLimit: 50,
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

  it("covers a healthy extended roster in two rotated runs despite one hot config", async () => {
    const { db } = fixtures.open();
    const template = MINT_BURN_CONFIGS.find((config) => config.tier === "extended"
      && config.chain.chainId === "ethereum" && config.events.length === 2)!;
    const configs = Array.from({ length: 129 }, (_, i) => makeConfig({
      ...template,
      contractAddress: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      startBlock: 22_000_001,
      tier: "extended",
    }));
    vi.mocked(syncMintBurnConfig).mockImplementation(async (input) => ({
      summary: {
        ...createMintBurnConfigSummary(input.config, input.key, input.tier, { attempted: true }),
        requestBudgetUsed: input.config === configs[0] ? input.configBudgetLimit : 2,
        requestBudgetLimit: input.configBudgetLimit,
      },
      apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0,
      atomicRoundtripsDetected: 0, newLastBlock: null,
    }));
    const attempted = new Set<string>();
    let rotated = configs;
    for (let cycle = 0; cycle < 2; cycle++) {
      const input = {
        ...makePhaseInput({ db, configs: rotated }),
        lane: "extended" as const,
        budget: { count: 14, limit: 200 },
        extendedConfigBudgetLimit: 25,
      };
      const result = await runMintBurnConfigPhase(input);
      expect(result.contractsProcessed).toBeGreaterThanOrEqual(65);
      expect(input.budget.count).toBeLessThanOrEqual(190);
      for (const summary of result.configBreakdown) {
        if (summary.attempted) attempted.add(summary.key);
      }
      rotated = resolveRotatedConfigs(resolveMintBurnResumeConfigKey(result.configBreakdown), configs,
        (config) => `${config.chain.chainId}-${config.contractAddress}`);
    }
    expect(attempted.size).toBe(129);
  });

  it("funds complete proofs instead of reproducing the 128-config log-only budget deadlock", async () => {
    const { db } = fixtures.open();
    const template = MINT_BURN_CONFIGS.find((config) => config.tier === "extended"
      && config.chain.chainId === "ethereum" && config.events.length === 2)!;
    const configs = Array.from({ length: 128 }, (_, i) => makeConfig({
      ...template, contractAddress: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      startBlock: 22_000_001, tier: "extended",
    }));
    const args = { ...makePhaseInput({ db, configs }), lane: "extended" as const,
      budget: { limit: 160, count: 21 }, extendedConfigBudgetLimit: 25 };
    let coldHeaders = true;
    vi.mocked(syncMintBurnConfig).mockImplementation(async (scan) => {
      // Eventful cold scan costs two log requests, an event-header batch and
      // boundary headers. Later quiet configs reuse those boundary headers.
      expect(scan.configBudgetLimit).toBeGreaterThanOrEqual(4);
      const requestBudgetUsed = coldHeaders ? 4 : 2;
      coldHeaders = false;
      return {
        summary: makeSummary({ key: scan.key, attempted: true, scanFrom: scan.fromBlock,
          scanTo: scan.scanTo, advancedTo: scan.scanTo, advanceReason: "full-success-empty", requestBudgetUsed }),
        apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0,
        newLastBlock: scan.scanTo,
        scanCoverage: { configKey: scan.key, configFingerprint: "test", chainId: "ethereum",
          fromBlock: scan.fromBlock, toBlock: scan.scanTo, fromTimestamp: NOW_SEC - 60,
          toTimestamp: NOW_SEC, finalizedBlock: scan.chainHead, acceptedAt: NOW_SEC },
      };
    });
    const result = await runMintBurnConfigPhase(args);
    expect(args.pendingCursorUpdates.size).toBeGreaterThan(50);
    expect(args.pendingCursorUpdates.size).toBe(result.contractsProcessed);
    expect(result.configBreakdown.some((summary) => summary.advanceReason === "scan-coverage-unproven")).toBe(false);
    expect(result.contractsDeferredExtended).toBeGreaterThan(0);
    expect(args.budget.count).toBeLessThanOrEqual(150);
  });

  it("defers without spending requests when a full scan and proof cannot fit", async () => {
    const { db } = fixtures.open();
    const template = MINT_BURN_CONFIGS.find((config) => config.events.length === 2)!;
    const config = makeConfig({ ...template, tier: "extended" });
    const args = { ...makePhaseInput({ db, configs: [config] }), lane: "extended" as const,
      budget: { limit: 160, count: 147 } };
    const result = await runMintBurnConfigPhase(args);
    expect(syncMintBurnConfig).not.toHaveBeenCalled();
    expect(args.budget.count).toBe(147);
    expect(result.configBreakdown[0]?.skippedReason).toBe("extended-deferred-under-pressure");
  });

  it("shrinks OUSD's seven-topic Dwellir range before preparing exact conservation boundaries", async () => {
    const { db } = fixtures.open();
    const config = { ...MINT_BURN_CONFIGS.find((candidate) => candidate.symbol === "OUSD")!, startBlock: 1 };
    expect(config.events).toHaveLength(2);
    expect(conservationOnlyEventDefsFor(config)).toHaveLength(5);
    const key = `${config.chain.chainId}-${config.contractAddress}`;
    const preferred = { ...mintBurnAlchemyEndpoint("https://dwellir.example"), operator: "dwellir" as const, maxLogBlockSpan: 10_000 };
    const context = { chainHead: 50_000, rpcEndpoints: [preferred, mintBurnAlchemyEndpoint("https://alchemy.example")],
      endpointHeads: new Map([[preferred.url, 50_000]]), chainTimestampCache: new Map<string, number>(), txContextCache: new Map() };
    const args = { ...makePhaseInput({ db, configs: [config] }), lane: "extended" as const,
      extendedConfigBudgetLimit: 25, chainContexts: new Map([[config.chain.chainId, context]]),
      lastBlocksAfterRun: new Map([[key, 0]]) };
    expect(mintBurnScanRequestFloor({ config, fromBlock: 1, scanTo: 50_000, ...context })).toBe(37);
    const boundary = { status: "unavailable" as const, reason: "audit-rpc-unavailable" as const };
    vi.mocked(fetchConservationBoundaries).mockResolvedValue(new Map([[key, boundary]]));
    vi.mocked(syncMintBurnConfig).mockImplementation(async (scan) => {
      const floor = mintBurnScanRequestFloor(scan);
      expect(floor).toBe(23);
      expect(scan.configBudgetLimit).toBeGreaterThanOrEqual(floor);
      expect(scan.configBudgetLimit).toBeLessThanOrEqual(25);
      expect(scan.conservationBoundary).toBe(boundary);
      return { summary: makeSummary({ key, attempted: true, scanFrom: scan.fromBlock, scanTo: scan.scanTo,
        advancedTo: scan.scanTo, advanceReason: "full-success-empty", requestBudgetUsed: floor }),
        apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0,
        newLastBlock: scan.scanTo, scanCoverage: { configKey: key, configFingerprint: "test", chainId: config.chain.chainId,
          fromBlock: scan.fromBlock, toBlock: scan.scanTo, fromTimestamp: NOW_SEC - 60,
          toTimestamp: NOW_SEC, finalizedBlock: scan.chainHead, acceptedAt: NOW_SEC } };
    });
    await runMintBurnConfigPhase(args);
    expect(args.pendingCursorUpdates.get(key)).toBe(25_000);
    args.lastBlocksAfterRun.set(key, args.pendingCursorUpdates.get(key)!);
    await runMintBurnConfigPhase(args);
    expect(args.pendingCursorUpdates.get(key)).toBe(50_000);
    expect(vi.mocked(syncMintBurnConfig).mock.calls.map(([scan]) => [scan.fromBlock, scan.scanTo]))
      .toEqual([[1, 25_000], [25_001, 50_000]]);
    expect(vi.mocked(fetchConservationBoundaries).mock.calls.map(([prepass]) =>
      prepass.requests.map((request) => [request.fromBlock, request.toBlock])))
      .toEqual([[[1, 25_000]], [[25_001, 50_000]]]);
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

  it("prepares exact loop ranges and stages completed cursors until aggregation succeeds", async () => {
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
        apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0, newLastBlock: input.scanTo,
        scanCoverage: { configKey: input.key, configFingerprint: "test", chainId: input.config.chain.chainId,
          fromBlock: input.fromBlock, toBlock: input.scanTo, fromTimestamp: NOW_SEC - 60,
          toTimestamp: NOW_SEC, finalizedBlock: input.chainHead, acceptedAt: NOW_SEC } };
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
    expect(upsertMintBurnSyncState).not.toHaveBeenCalled();
    expect(args.pendingCursorUpdates).toEqual(new Map([[keys[0], 135], [keys[1], 125]]));
    expect(args.lastBlocksAfterRun).toEqual(new Map([[keys[0], 110], [keys[2], 150]]));
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
