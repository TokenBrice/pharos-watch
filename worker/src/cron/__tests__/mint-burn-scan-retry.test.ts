import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { fetchConservationBoundaries, getMintBurnConservationEligibility } from "../../lib/mint-burn-conservation";
import { createMintBurnConfigSummary, syncMintBurnConfig } from "../mint-burn/sync-config";
import type { SyncMintBurnConfigInput } from "../mint-burn/sync-config";
import type * as SyncConfigModule from "../mint-burn/sync-config";
import { mintBurnScanRequestFloor, syncMintBurnConfigWithRetries } from "../mint-burn/scan-with-retry";

vi.mock("../mint-burn/sync-config", async (importOriginal) => ({
  ...await importOriginal<typeof SyncConfigModule>(), syncMintBurnConfig: vi.fn(),
}));
vi.mock("../../lib/mint-burn-conservation", () => ({
  fetchConservationBoundaries: vi.fn(),
  conservationOnlyEventDefsFor: () => [],
  getMintBurnConservationEligibility: vi.fn(() => ({ supported: false })),
}));
const config = makeMintBurnConfig({ events: [{ signature: "Mint(uint256)", topicHash: `0x${"1".repeat(64)}`,
  direction: "mint", amountEncoding: "first-data-uint256" }] });
function input(): SyncMintBurnConfigInput {
  return { db: {} as D1Database, config, key: "key", tier: "critical", fromBlock: 100, scanTo: 199,
    chainHead: 200, rpcEndpoints: [], configBudgetLimit: 20, runTimestamp: 1200,
    priceContext: { priceObservations: new Map(), priceHistory: new Map() }, chainTimestampCache: new Map(),
    txContextCache: new Map(), affectedHours: new Map(), conservationBoundary: { status: "unavailable", reason: "audit-rpc-unavailable" } };
}
beforeEach(() => {
  vi.mocked(getMintBurnConservationEligibility).mockReturnValue({ supported: false });
  vi.mocked(fetchConservationBoundaries).mockReset().mockResolvedValue(new Map());
  vi.mocked(syncMintBurnConfig).mockReset().mockImplementation(async (request) => ({
    summary: { ...createMintBurnConfigSummary(config, request.key, request.tier),
      requestBudgetUsed: request.configBudgetLimit, errors: 1, advanceReason: "scan-coverage-unproven" },
    apiErrors: 1, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0, newLastBlock: null,
  }));
});
describe("certified adaptive scan prefixes", () => {
  it("reserves retry requests and never exceeds the per-config budget", async () => {
    const result = await syncMintBurnConfigWithRetries(input());
    expect(result.newLastBlock).toBeNull();
    expect(result.summary).toMatchObject({ scanAttempts: 3, requestBudgetUsed: 20, advanceReason: "scan-coverage-unproven" });
    expect(vi.mocked(syncMintBurnConfig).mock.calls.map(([scan]) => [scan.fromBlock, scan.scanTo, scan.configBudgetLimit]))
      .toEqual([[100, 199, 10], [100, 149, 5], [100, 124, 5]]);
  });
  it("certifies a smaller prefix with fresh conservation boundaries and retains prior failure health", async () => {
    const request = input();
    const boundary = { status: "unavailable" as const, reason: "incomplete-log-range" as const };
    vi.mocked(fetchConservationBoundaries).mockImplementation(async ({ budget }) => {
      budget.count += 1;
      return new Map([[request.key, boundary]]);
    });
    vi.mocked(syncMintBurnConfig).mockImplementation(async (scan) => ({
      summary: { ...createMintBurnConfigSummary(config, scan.key, scan.tier), requestBudgetUsed: 2,
        errors: scan.scanTo === 199 ? 1 : 0, advanceReason: "full-success-empty" },
      apiErrors: scan.scanTo === 199 ? 1 : 0, rpcEvidenceIncomplete: scan.scanTo === 199,
      effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0,
      newLastBlock: scan.scanTo === 199 ? null : scan.scanTo,
      ...(scan.scanTo === 199 ? {} : { scanCoverage: { configKey: scan.key, configFingerprint: "test", chainId: config.chain.chainId,
        fromBlock: scan.fromBlock, toBlock: scan.scanTo, fromTimestamp: 1000, toTimestamp: 1100, finalizedBlock: 200, acceptedAt: 1200 } }),
    }));
    const result = await syncMintBurnConfigWithRetries(request);
    expect(result.newLastBlock).toBe(149);
    expect(result.scanCoverage?.toBlock).toBe(149);
    expect(result.rpcEvidenceIncomplete).toBe(false);
    expect(result.summary).toMatchObject({ scanAttempts: 2, advanceReason: "partial-frontier", requestBudgetUsed: 5, errors: 1 });
    expect(fetchConservationBoundaries).toHaveBeenCalledWith(expect.objectContaining({
      requests: [{ key: request.key, config, fromBlock: 100, toBlock: 149 }],
    }));
    expect(vi.mocked(syncMintBurnConfig).mock.calls[1]![0].conservationBoundary).toBe(boundary);
  });
  it("does not retry or skip a permanently unproved single block", async () => {
    const result = await syncMintBurnConfigWithRetries({ ...input(), scanTo: 100 });
    expect(result.newLastBlock).toBeNull();
    expect(result.summary).toMatchObject({ scanAttempts: 1, advanceReason: "scan-coverage-unproven" });
    expect(syncMintBurnConfig).toHaveBeenCalledTimes(1);
    expect(fetchConservationBoundaries).not.toHaveBeenCalled();
  });
  it("does not start another attempt past the deadline", async () => {
    const result = await syncMintBurnConfigWithRetries({ ...input(), deadlineMs: Date.now() + 1000 });
    expect(result.summary.scanAttempts).toBe(1);
  });
  it.each(["timestamp", "decode", "partial-topic", "quarantine"])("re-scans exactly before a known %s failure near the range start", async (failure) => {
    const request = { ...input(), scanTo: 50_000, chainHead: 50_000 };
    vi.mocked(syncMintBurnConfig).mockImplementation(async (scan) => {
      const summary = createMintBurnConfigSummary(config, scan.key, scan.tier);
      summary.requestBudgetUsed = 2;
      summary.coverageFrontier = scan.scanTo > 102 ? 99 : scan.scanTo;
      if (scan.scanTo > 102) {
        if (failure === "timestamp") summary.earliestMissingTimestampBlock = 103;
        if (failure === "decode") summary.earliestDecodeFailureBlock = 103;
        if (failure === "partial-topic") summary.coverageFrontier = 102;
        if (failure === "quarantine") summary.decodeQuarantines = [{
          blockNumber: 103, transactionHash: "0xfailed", logIndex: "0x0", reason: "amount-decode-retry-exhausted", attempts: 3,
        }];
      }
      return { summary, apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0,
        newLastBlock: scan.scanTo > 102 ? null : scan.scanTo,
        ...(scan.scanTo > 102 ? {} : { scanCoverage: { configKey: scan.key, configFingerprint: "test", chainId: "ethereum",
          fromBlock: scan.fromBlock, toBlock: scan.scanTo, fromTimestamp: 1000, toTimestamp: 1100, finalizedBlock: 50_000, acceptedAt: 1200 } }) };
    });
    const result = await syncMintBurnConfigWithRetries(request);
    expect(vi.mocked(syncMintBurnConfig).mock.calls.map(([scan]) => [scan.fromBlock, scan.scanTo])).toEqual([[100, 50_000], [100, 102]]);
    expect(result.newLastBlock).toBe(102);
    expect(result.scanCoverage?.toBlock).toBe(102);
    expect(result.summary.scanAttempts).toBe(2);
  });

  it("reserves all three fresh conservation batches before retrying a supported prefix", async () => {
    vi.mocked(getMintBurnConservationEligibility).mockReturnValue({ supported: true });
    vi.mocked(fetchConservationBoundaries).mockImplementation(async ({ budget }) => {
      budget.count += 3;
      return new Map();
    });
    await syncMintBurnConfigWithRetries({ ...input(), configBudgetLimit: 9 });
    expect(vi.mocked(syncMintBurnConfig).mock.calls.map(([scan]) => scan.configBudgetLimit)).toEqual([3, 3]);
  });

  it("includes paged logs, a cold provider head and both header phases in the request floor", () => {
    const request = input();
    const preferred = { url: "https://rpc.example", operator: "dwellir" as const, keyed: true, position: "registry" as const,
      stateHistory: "archive" as const, logsHistory: "full" as const, maxLogBlockSpan: 10_000 };
    const scan = { ...request, fromBlock: 1, scanTo: 50_000,
      rpcEndpoints: [preferred, { ...preferred, url: "https://fallback.example", operator: "alchemy" as const }] };
    expect(mintBurnScanRequestFloor(scan)).toBe(8);
    expect(mintBurnScanRequestFloor({ ...scan, endpointHeads: new Map([[preferred.url, 50_000]]) })).toBe(7);
  });
});
