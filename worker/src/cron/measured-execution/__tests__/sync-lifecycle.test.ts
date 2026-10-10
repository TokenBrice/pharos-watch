import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEX_MEASURED_FRESHNESS_MAX_SEC, validateDexMeasuredExecutionProfile, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type * as Persistence from "../persistence";
import type * as Admission from "../admission";
import type * as EvmRpc from "../../../lib/evm-rpc";
import type * as Quoter from "../quoter-v2";
import type * as Registry from "../registry";
import type { DexMeasuredQuoteOutcome } from "../persistence";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { makeV3Target } from "./measured-execution.test-support";
import { syncDexMeasuredExecution, syncDexShadowMeasuredExecution } from "../sync";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), publish: vi.fn(), block: vi.fn(), header: vi.fn(), verify: vi.fn(), bindings: vi.fn(), quotes: vi.fn(),
}));
vi.mock("../persistence", async (importOriginal) => ({
  ...await importOriginal<typeof Persistence>(),
  loadLatestPublishedDexMeasuredTargets: mocks.load,
  publishDexMeasuredQuoteGeneration: mocks.publish,
  loadLatestPublishedDexShadowMeasuredTargets: mocks.load,
  loadPositiveEmptyPoolQuarantines: vi.fn(async () => new Map()),
  publishDexShadowMeasuredQuoteGeneration: mocks.publish,
  pruneDexMeasuredExecutionGenerations: vi.fn(async () => ({ deleted: 0 })),
}));
vi.mock("../admission", async (importOriginal) => ({
  ...await importOriginal<typeof Admission>(),
  loadPublishedScoreBearingDexRoutes: vi.fn(async () => []),
}));
vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof EvmRpc>(),
  fetchEvmBlockNumber: mocks.block,
  fetchEvmBlockHeader: mocks.header,
}));
vi.mock("../../dex-liquidity/source-pagination-state", () => ({
  readDexSourcePaginationState: vi.fn(async () => ({ cursor: null, cycleStartedAt: null })),
  writeDexSourcePaginationState: vi.fn(async () => ({ written: true })),
}));
vi.mock("../registry", async (importOriginal) => ({
  ...await importOriginal<typeof Registry>(),
  verifyDexMeasuredExecutionDeployment: mocks.verify,
}));
vi.mock("../quoter-v2", async (importOriginal) => ({
  ...await importOriginal<typeof Quoter>(),
  resolveQuoterV2PoolBindings: mocks.bindings,
  quoteQuoterV2Requests: mocks.quotes,
  validateQuoterV2ProfileProof: vi.fn(() => []),
}));

beforeEach(() => {
  mocks.load.mockReset();
  mocks.block.mockReset().mockResolvedValue(null);
  mocks.header.mockReset().mockResolvedValue(null);
  mocks.verify.mockReset().mockResolvedValue({ ok: true, codeHash: `0x${"ab".repeat(32)}` });
  mocks.bindings.mockReset().mockImplementation(async ({ requests }: Parameters<typeof Quoter.resolveQuoterV2PoolBindings>[0]) =>
    requests.map(({ target, factoryAddress, factoryCodeHash }) => ({ proof: {
      factoryAddress, factoryCodeHash, resolvedPoolAddress: target.poolId.split(":")[1],
      callData: "0x12", returnData: "0x34",
    } })));
  mocks.quotes.mockReset().mockImplementation(async ({ requests }: Parameters<typeof Quoter.quoteQuoterV2Requests>[0]) =>
    requests.map(({ target, inputUsd }) => ({ point: {
      amountInRaw: (BigInt(inputUsd) * 10n ** BigInt(target.tokenIn.decimals)).toString(),
      amountOutRaw: (BigInt(inputUsd) * 10n ** BigInt(target.tokenOut.decimals)).toString(),
      callData: "0x12", returnData: "0x34", inputUsd, outputUsd: inputUsd,
      costBps: 0, passesCostBound: true,
    } })));
  mocks.publish.mockReset().mockImplementation(async ({ generationId, outcomes }) => ({
    generationId, measuredCount: 0, failedCount: outcomes.length,
  }));
});
afterEach(() => vi.restoreAllMocks());

function catalog(targets: DexMeasuredExecutionTarget[]) {
  return { generationId: "pre-retirement-shadow-targets", publishedAt: 1_000, targets };
}

const retired = [
  makeV3Target({ adapterProfileId: "hybra-v3-quoter-v2", protocol: "hybra-finance-v3", chain: "hyperevm" }),
  makeV3Target({ adapterProfileId: "xswap-v3-quoter-v2", protocol: "xswap-v3", chain: "xdc" }),
  makeV3Target({ adapterProfileId: "uniswap-v4-hook-free-quoter-v1", protocol: "uniswap-v4", chain: "unichain" }),
  makeV3Target({ chain: "ethereum" }),
];

describe("measured EVM source-header admission", () => {
  const now = 1_790_000_000;
  const blockNumber = 25_536_894;

  it.each([
    ["old responsive head", now - DEX_MEASURED_FRESHNESS_MAX_SEC - 1, "stale-pinned-block"],
    ["future head", now + 61, "future-pinned-block"],
    ["missing header", null, "block-header-unavailable"],
  ] as const)("does not refresh measured evidence from %s", async (_label, timestamp, reason) => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const target = makeV3Target({ capturedAt: now - DEX_MEASURED_FRESHNESS_MAX_SEC - 600 });
    mocks.load.mockResolvedValue(catalog([target]));
    mocks.block.mockResolvedValue(blockNumber);
    mocks.header.mockResolvedValue(timestamp == null ? null : {
      number: blockNumber, timestamp, hash: `0x${"ab".repeat(32)}`,
    });
    await syncDexMeasuredExecution(makeNoopD1(), new Map());
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      outcomes: [expect.objectContaining({ status: "failed", failureReason: reason })],
    }));
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.quotes).not.toHaveBeenCalled();
  });

  it.each([30, DEX_MEASURED_FRESHNESS_MAX_SEC])("publishes the original source clock at inclusive age %s", async (age) => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const target = makeV3Target({ capturedAt: now - DEX_MEASURED_FRESHNESS_MAX_SEC - 600 });
    const generation = catalog([target]);
    mocks.load.mockResolvedValue(generation);
    mocks.block.mockResolvedValue(blockNumber);
    mocks.header.mockResolvedValue({ number: blockNumber, timestamp: now - age, hash: `0x${"ab".repeat(32)}` });
    await syncDexMeasuredExecution(makeNoopD1(), new Map());
    const publication = mocks.publish.mock.calls[0]![0];
    const outcome = publication.outcomes[0] as DexMeasuredQuoteOutcome;
    expect(outcome.status).toBe("measured");
    expect(outcome.profile?.quotedAt).toBe(now - age);
    expect(publication.quotedAt).toBe(now);
    expect(mocks.header).toHaveBeenCalledWith("ethereum", blockNumber, expect.any(Object));
    expect(validateDexMeasuredExecutionProfile({
      profile: outcome.profile, quotedTarget: target, currentTarget: target,
      expectedTargetGenerationId: generation.generationId,
      expectedQuoteGenerationId: publication.generationId,
      nowSec: now - age + DEX_MEASURED_FRESHNESS_MAX_SEC + 1,
    })).toContain("stale-observation");
  });
});

describe("current shadow membership at the persisted catalog boundary", () => {
  it("never requotes retired or moved-active IDs from an old published pointer", async () => {
    mocks.load.mockResolvedValue(catalog(retired));
    await syncDexShadowMeasuredExecution(makeNoopD1(), new Map());
    expect(mocks.block).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      outcomes: retired.map((target) => expect.objectContaining({
        target, status: "failed", failureReason: "current-policy-target-excluded", observedThisRun: false,
      })),
    }));
  });

  it("still attempts remaining Base V3 shadow members while refusing obsolete IDs", async () => {
    const remaining = makeV3Target({ chain: "base" });
    mocks.load.mockResolvedValue(catalog([...retired, remaining]));
    await syncDexShadowMeasuredExecution(makeNoopD1(), new Map());
    expect(mocks.block).toHaveBeenCalledTimes(1);
    expect(mocks.block.mock.calls[0]![0]).toBe("base");
    expect(mocks.publish.mock.calls[0]![0].outcomes).toContainEqual(expect.objectContaining({
      target: remaining, failureReason: "block-number-unavailable", observedThisRun: true,
    }));
  });

  it.each([null, catalog([])])("distinguishes missing and intentional empty catalogs without publishing quotes", async (generation) => {
    mocks.load.mockResolvedValue(generation);
    const result = await syncDexShadowMeasuredExecution(makeNoopD1(), new Map());
    expect(result.productivity?.reason).toBe(generation ? "target-generation-empty" : "target-generation-missing");
    expect(mocks.block).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not convert a failed catalog read into accepted empty evidence", async () => {
    mocks.load.mockRejectedValue(new Error("catalog-read-failed"));
    await expect(syncDexShadowMeasuredExecution(makeNoopD1(), new Map())).rejects.toThrow("catalog-read-failed");
    expect(mocks.block).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
