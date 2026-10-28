import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createDwellirNativeCapability } from "../../lib/dwellir-native";
import * as providerBudget from "../../lib/rpc-provider-budget";
import * as evmLogs from "../../lib/evm-logs";
import * as alchemy from "../../lib/alchemy-logs";
import { MINT_BURN_CONFIGS } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import { readMintBurnWindowContext } from "../../lib/mint-burn-flows-service";
import { isGrandfatheredMintBurnConfig } from "../../lib/mint-burn-publication";
import { loadMintBurnChainContexts } from "../mint-burn/chain-context";
import { syncMintBurnConfig, type SyncMintBurnConfigInput } from "../mint-burn/sync-config";
import { runMintBurnConfigPhase } from "../mint-burn/run-configs";
import { syncMintBurn } from "../sync-mint-burn";
import { mintBurnScanFingerprint } from "../../lib/mint-burn-pipeline/scan-coverage";
import * as circuit from "../../lib/circuit-breaker";
import { withRpcRequestObserver, type RpcRequestScope } from "../../lib/rpc-request-observer";

const CONFIG = MINT_BURN_CONFIGS.find((config) => config.chain.chainId === "tron")!;
const KEY = mintBurnConfigKey(CONFIG);
const ADDRESS = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = `0x${"0".repeat(64)}`;
const TREASURY = "0x0000000000000000000000000fa695d6b065707cb4e0ef73b751c93347682bf2";
const NOW = Date.parse("2026-10-28T22:00:00Z") / 1000;
const START = Date.parse("2026-07-28T00:00:00Z") / 1000;
const quantity = (value: number) => `0x${value.toString(16)}`;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;
const fixtures = createLatestSchemaFixtureTracker();

interface RpcRequest { id: number; method?: string; params?: unknown[] }
interface LogFilter { fromBlock: string; toBlock: string; address: string; topics: string[][] }

function transport(options: {
  head?: number;
  timestamp?: (block: number) => number;
  logs?: alchemy.AlchemyLogEntry[];
  respond?: (url: string, request: RpcRequest) => Response | undefined;
} = {}) {
  const head = options.head ?? CONFIG.startBlock + 600;
  const timestamp = options.timestamp ?? ((block: number) => NOW - 60 - (head - block) * 3);
  const ranges: Array<[number, number, string[]]> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const request: RpcRequest = JSON.parse(String(init?.body));
    const custom = options.respond?.(url, request);
    if (custom) return custom;
    if (url.endsWith("/walletsolidity/getnowblock")) return Response.json({
      blockID: hash(head).slice(2),
      block_header: { raw_data: { number: head, timestamp: timestamp(head) * 1000 } },
    });
    let result: unknown;
    if (request.method === "eth_blockNumber") result = quantity(head + 20);
    else if (request.method === "eth_getBlockByNumber") {
      const number = Number(request.params![0]);
      result = { number: quantity(number), hash: hash(number), timestamp: quantity(timestamp(number)) };
    } else if (request.method === "eth_getLogs") {
      const filter = request.params![0] as LogFilter;
      const from = Number(filter.fromBlock), to = Number(filter.toBlock);
      ranges.push([from, to, filter.topics[0]]);
      expect(filter.address).toBe(ADDRESS);
      result = (options.logs ?? []).filter((log) => Number(log.blockNumber) >= from
        && Number(log.blockNumber) <= to && filter.topics[0].includes(log.topics[0]));
    } else throw new Error(`Unexpected Tron read: ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  vi.stubGlobal("fetch", fetcher);
  return { head, timestamp, ranges, fetcher, native: createDwellirNativeCapability("test-dwellir-key") };
}

async function phaseInput(network: ReturnType<typeof transport>, db: D1Database, now = NOW) {
  const budget = { count: 0, limit: 60 };
  const chainContexts = await loadMintBurnChainContexts({ configs: [CONFIG], apiKey: "", budget,
    dwellirNative: network.native, trongridAllowed: false });
  return {
    db, configs: [CONFIG], pendingAdmissionKeys: new Set([KEY]), lane: "critical" as const,
    jobName: "sync-mint-burn", budget, chainContexts, runTimestamp: now,
    priceContext: { priceObservations: new Map(), priceHistory: new Map() },
    lastBlocksAfterRun: new Map<string, number>(), pendingCursorUpdates: new Map<string, number>(),
    pendingScanCoverage: new Map(), maxScanRange: 50_000, criticalConfigBudgetLimit: 60,
    extendedConfigBudgetLimit: 25, affectedHours: new Map(), deadlineMs: Date.now() + 120_000,
  } satisfies Parameters<typeof runMintBurnConfigPhase>[0];
}

async function scanInput(network: ReturnType<typeof transport>, overrides: Partial<SyncMintBurnConfigInput> = {}) {
  const { db, sqlite } = fixtures.open();
  const phase = await phaseInput(network, db);
  const context = phase.chainContexts.get("tron")!;
  expect(context.chainHead).toBe(network.head);
  const input: SyncMintBurnConfigInput = {
    db, config: CONFIG, key: KEY, tier: "critical", fromBlock: CONFIG.startBlock,
    scanTo: network.head, chainHead: network.head, rpcEndpoints: context.rpcEndpoints,
    tronReader: context.tronReader, configBudgetLimit: 60, runTimestamp: NOW,
    priceContext: phase.priceContext, chainTimestampCache: context.chainTimestampCache,
    txContextCache: context.txContextCache, affectedHours: new Map(), deadlineMs: Date.now() + 120_000,
    ...overrides,
  };
  return { input, phase, sqlite };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  vi.spyOn(evmLogs, "createRateLimiter").mockReturnValue((fn) => fn());
  vi.spyOn(providerBudget, "recordDwellirCredits").mockImplementation(() => {});
  vi.spyOn(alchemy, "buildAlchemyUrl");
});
afterEach(() => {
  const methods = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method);
  expect(methods).not.toContain("eth_call");
  expect(alchemy.buildAlchemyUrl).not.toHaveBeenCalled();
  fixtures.closeAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Tron mint/burn admission transport", () => {
  it("scopes native heads and pending scan boundaries without Alchemy evidence", async () => {
    const network = transport();
    const { db } = fixtures.open();
    const scopes: RpcRequestScope[] = [];
    const onOutcome = vi.fn();
    await withRpcRequestObserver({
      beforeRequest: () => true, onOutcome,
      onScopeStart: (scope) => { scopes.push(scope); }, onScopeComplete: () => {},
    }, async () => {
      await runMintBurnConfigPhase(await phaseInput(network, db));
    });
    expect(scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "chain-head", key: "tron" }),
      expect.objectContaining({ kind: "chain-head", key: "tron", affectsRun: false }),
      expect.objectContaining({ kind: "operation", key: `${KEY}:scan-boundaries`, affectsRun: false }),
      expect.objectContaining({ kind: "operation", key: `${KEY}:tron-solid-head`, affectsRun: false }),
    ]));
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("charges the real reader's quiet scan and keeps conservation unsupported", async () => {
    const network = transport();
    const { input, phase } = await scanInput(network);
    const result = await syncMintBurnConfig(input);
    expect(phase.budget.count).toBe(3);
    expect(result.summary).toMatchObject({ requestBudgetUsed: 3, conservationStatus: "unsupported",
      conservationReason: "tron-historical-state-unavailable", advanceReason: "full-success-empty" });
    expect(result.scanCoverage).toMatchObject({ fromBlock: CONFIG.startBlock, toBlock: network.head,
      finalizedBlock: network.head });
    expect(network.fetcher).toHaveBeenCalledTimes(6);
  });

  it.each(["mint", "burn"] as const)("counts %s once despite its paired zero-address Transfer", async (direction) => {
    const block = CONFIG.startBlock;
    const event = CONFIG.events.find((entry) => entry.direction === direction)!;
    const log: alchemy.AlchemyLogEntry = { address: ADDRESS, topics: [event.topicHash],
      data: `0x${(1_000_000n * 1_000_000n).toString(16).padStart(64, "0")}`, blockNumber: quantity(block),
      blockHash: hash(block), transactionHash: hash(block + 1), transactionIndex: "0x0", logIndex: "0x0", removed: false };
    const paired = { ...log, logIndex: "0x1",
      topics: direction === "mint" ? [TRANSFER, ZERO, TREASURY] : [TRANSFER, TREASURY, ZERO] };
    const network = transport({ logs: [log, paired] });
    const { input, sqlite } = await scanInput(network, { scanTo: block, priceContext: {
      priceHistory: new Map(), priceObservations: new Map([[CONFIG.stablecoinId, {
        price: 1, observedAt: network.timestamp(block), source: "binance", observedAtMode: "local_fetch",
      }]]),
    } });
    const result = await syncMintBurnConfig(input);
    expect(result.summary).toMatchObject({ rowsRead: 1, rowsParsed: 1, rowsInserted: 1,
      conservationStatus: "unsupported", conservationReason: "tron-historical-state-unavailable" });
    expect(sqlite.prepare("SELECT direction, amount, amount_usd, explorer_tx_url FROM mint_burn_events").all())
      .toEqual([{ direction, amount: 1_000_000, amount_usd: 1_000_000,
        explorer_tx_url: `https://tronscan.org/#/transaction/${log.transactionHash.slice(2)}` }]);
    expect(network.ranges.map((range) => range[2])).toEqual(CONFIG.events.map((entry) => [entry.topicHash]));
    expect(result.scanCoverage?.toBlock).toBe(block);
  });

  it.each(["stale", "failed"] as const)("keeps a %s solid head out of up-to-date and coverage claims", async (failure) => {
    const network = transport(failure === "stale" ? { timestamp: () => NOW - 601 } : {
      respond: () => new Response("unavailable", { status: 503 }),
    });
    const { db } = fixtures.open();
    const input = await phaseInput(network, db);
    input.lastBlocksAfterRun.set(KEY, network.head);
    const result = await runMintBurnConfigPhase(input);
    expect(result.configBreakdown[0]).toMatchObject({ attempted: false, advancedTo: null,
      skippedReason: failure === "stale" ? "tron-rpc-stale-solid-head" : "tron-rpc-providers-unavailable" });
    expect(input.pendingCursorUpdates.size).toBe(0);
    expect(input.pendingScanCoverage.size).toBe(0);
    expect(network.ranges).toEqual([]);
  });

  it("rechecks cached head freshness before skipping an already-scanned config", async () => {
    const head = CONFIG.startBlock + 600;
    const network = transport({ head, timestamp: (block) => NOW - 300 - (head - block) * 3 });
    const { db } = fixtures.open();
    const input = await phaseInput(network, db);
    const headBudget = input.budget;
    input.budget = { count: 0, limit: 1 };
    input.lastBlocksAfterRun.set(KEY, network.head);
    vi.mocked(Date.now).mockReturnValue((NOW + 301) * 1000);
    input.deadlineMs = Date.now() + 120_000;
    const result = await runMintBurnConfigPhase(input);
    expect(result.configBreakdown[0].skippedReason).toBe("tron-rpc-stale-solid-head");
    expect(input.pendingScanCoverage.size).toBe(0);
    expect(headBudget.count).toBe(3);
    expect(input.budget.count).toBe(1);
    expect(network.fetcher).toHaveBeenCalledTimes(4);
  });

  it("refuses proof when the validated head becomes stale during a scan", async () => {
    const head = CONFIG.startBlock + 600;
    const network = transport({ head, timestamp: (block) => NOW - 300 - (head - block) * 3, respond: (_url, request) => {
      if (request.method === "eth_getBlockByNumber" && Number(request.params![0]) === CONFIG.startBlock) {
        vi.mocked(Date.now).mockReturnValue((NOW + 301) * 1000);
      }
      return undefined;
    } });
    const { input } = await scanInput(network, { deadlineMs: (NOW + 500) * 1000 });
    const result = await syncMintBurnConfig(input);
    expect(result.newLastBlock).toBeNull();
    expect(result.scanCoverage).toBeUndefined();
    expect(result.summary).toMatchObject({ sourceFailureReason: "tron-rpc-stale-solid-head",
      headFailureReason: "tron-rpc-stale-solid-head",
      advanceReason: "scan-coverage-unproven" });
  });

  it.each([
    { admitted: true, failureStage: "before-scan" },
    { admitted: true, failureStage: "proof" },
    { admitted: true, failureStage: "second-topic" },
    { admitted: false, failureStage: "proof" },
  ])("reports late head failure through completion (admitted: $admitted, stage: $failureStage)", async ({ admitted, failureStage }) => {
    const head = CONFIG.startBlock + 600;
    const network = transport({ head, timestamp: (block) => NOW - 300 - (head - block) * 3,
      respond: (_url, request) => {
        if (failureStage === "proof" && request.method === "eth_getBlockByNumber"
          && Number(request.params![0]) === CONFIG.startBlock) vi.mocked(Date.now).mockReturnValue((NOW + 301) * 1000);
        if (failureStage === "second-topic" && request.method === "eth_getLogs") {
          vi.mocked(Date.now).mockReturnValue((NOW + 301) * 1000);
        }
        return undefined;
      },
    });
    vi.spyOn(circuit, "shouldAttemptFetch").mockResolvedValue(false);
    const { db, sqlite } = fixtures.open();
    if (admitted) sqlite.prepare(`INSERT INTO mint_burn_admission
      (config_key, config_fingerprint, admitted_at, baseline_from, baseline_to) VALUES (?, ?, ?, ?, ?)`)
      .run(KEY, mintBurnScanFingerprint(CONFIG), NOW - 1, START, NOW - 1);
    const initialCursor = failureStage === "before-scan" ? head : CONFIG.startBlock - 1;
    await upsertMintBurnSyncState(db, KEY, initialCursor, "monotonic-max");
    const result = await syncMintBurn(db, null, {
      lane: "critical", dwellirNative: network.native,
      disabledConfigIds: MINT_BURN_CONFIGS.filter((config) => config.chain.chainId !== "tron").map(mintBurnConfigKey),
      onProgress: async (update) => {
        if (failureStage === "before-scan" && update.stage === "critical-queue") {
          vi.mocked(Date.now).mockReturnValue((NOW + 301) * 1000);
        }
      },
    });
    const metadata = JSON.parse(result.metadata);
    expect(result.status).toBe(admitted ? "degraded" : "ok");
    expect(metadata.chainHeads).not.toHaveProperty("tron");
    expect(metadata.finality.unavailableChains).toEqual(["tron"]);
    expect(metadata.admittedFinalityUnavailableChains).toEqual(admitted ? ["tron"] : []);
    expect(metadata.configSamples[0]).toMatchObject(failureStage === "before-scan"
      ? { skippedReason: "tron-rpc-stale-solid-head", advancedTo: null }
      : { headFailureReason: failureStage === "second-topic" ? "tron-rpc-providers-unavailable" : "tron-rpc-stale-solid-head",
        sourceFailureReason: "tron-rpc-stale-solid-head", advancedTo: null });
    expect(sqlite.prepare("SELECT last_block FROM mint_burn_sync_state WHERE config_key = ?").get(KEY))
      .toEqual({ last_block: initialCursor });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_scan_coverage WHERE config_key = ?").get(KEY))
      .toEqual({ count: 0 });
  });

  it("commits a smaller eventful prefix when cold timestamps exhaust the first attempt", async () => {
    const { db } = fixtures.open();
    const logs = [CONFIG.startBlock + 100, CONFIG.startBlock + 200].map((block): alchemy.AlchemyLogEntry => ({
      address: ADDRESS, topics: [CONFIG.events[0].topicHash],
      data: `0x${(1_000_000n * 1_000_000n).toString(16).padStart(64, "0")}`, blockNumber: quantity(block),
      blockHash: hash(block), transactionHash: hash(block + 1), transactionIndex: "0x0", logIndex: "0x0", removed: false,
    }));
    const network = transport({ head: CONFIG.startBlock + 500_000, logs });
    const input = await phaseInput(network, db);
    const result = await runMintBurnConfigPhase(input);
    expect(result.configBreakdown[0]).toMatchObject({ scanAttempts: 2, advanceReason: "partial-frontier" });
    expect(result.configBreakdown[0].scanAttemptRanges?.[0].reason).toBe("scan-coverage-unproven");
    const proof = input.pendingScanCoverage.get(KEY);
    expect(proof).toMatchObject({ fromBlock: CONFIG.startBlock, toBlock: CONFIG.startBlock + 84_999 });
    expect(input.budget.count).toBeLessThanOrEqual(60);
    expect(input.budget.count).toBe(network.fetcher.mock.calls.length);
    await recalcAffectedHours(db, input.affectedHours);
    await upsertMintBurnSyncState(db, KEY, proof.toBlock, "monotonic-max", proof);

    const next = await phaseInput(network, db);
    next.lastBlocksAfterRun.set(KEY, proof.toBlock);
    const resumed = await runMintBurnConfigPhase(next);
    expect(resumed.configBreakdown[0].scanFrom).toBe(proof.toBlock + 1);
    expect(next.pendingScanCoverage.get(KEY)?.toBlock).toBeGreaterThan(proof.toBlock);
    expect(next.budget.count).toBeLessThanOrEqual(60);
  });

  it("catches up the reviewed floor in sixteen moving-frontier opportunities under 60 requests each", async () => {
    const { db } = fixtures.open();
    expect(isGrandfatheredMintBurnConfig(CONFIG)).toBe(false);
    expect(NOW - START).toBeGreaterThan(90 * 86400);
    const lastBlocks = new Map<string, number>();
    let totalRequests = 0;
    for (let opportunity = 0; opportunity < 16; opportunity++) {
      const now = NOW + opportunity * 1800;
      vi.mocked(Date.now).mockReturnValue(now * 1000);
      const head = CONFIG.startBlock + Math.floor((now - 60 - START) / 3);
      const network = transport({ head, timestamp: (block) => START + (block - CONFIG.startBlock) * 3 });
      const input = await phaseInput(network, db, now);
      input.lastBlocksAfterRun = lastBlocks;
      const result = await runMintBurnConfigPhase(input);
      expect(result.configBreakdown[0].conservationStatus).toBe("unsupported");
      expect(input.budget.count).toBeLessThanOrEqual(60);
      expect(input.budget.count).toBe(network.fetcher.mock.calls.length);
      const proof = input.pendingScanCoverage.get(KEY);
      expect(proof).toBeDefined();
      expect(proof.toBlock - proof.fromBlock + 1).toBeLessThanOrEqual(170_000);
      await upsertMintBurnSyncState(db, KEY, proof.toBlock, "monotonic-max", proof);
      lastBlocks.set(KEY, proof.toBlock);
      const context = await readMintBurnWindowContext(db, now, [CONFIG]);
      expect(context.publication.legs[0].status).toBe(opportunity < 15 ? "pending-admission" : "admitted");
      if (opportunity === 15) {
        expect(proof.toBlock).toBe(head);
        expect(context.watermark.timestamp).toBe(Math.floor((now - 60) / 3600) * 3600);
        expect(context.publication.legs[0].coveredSeconds).toBeGreaterThanOrEqual(90 * 86400);
      }
      totalRequests += input.budget.count;
    }
    expect(totalRequests).toBe(617);
  });
});
