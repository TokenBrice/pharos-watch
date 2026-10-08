import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type * as Persistence from "../persistence";
import type * as EvmRpc from "../../../lib/evm-rpc";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { makeV3Target } from "./measured-execution.test-support";
import { syncDexShadowMeasuredExecution } from "../sync";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), publish: vi.fn(), block: vi.fn(),
}));
vi.mock("../persistence", async (importOriginal) => ({
  ...await importOriginal<typeof Persistence>(),
  loadLatestPublishedDexShadowMeasuredTargets: mocks.load,
  loadPositiveEmptyPoolQuarantines: vi.fn(async () => new Map()),
  publishDexShadowMeasuredQuoteGeneration: mocks.publish,
  pruneDexMeasuredExecutionGenerations: vi.fn(async () => ({ deleted: 0 })),
}));
vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof EvmRpc>(),
  fetchEvmBlockNumber: mocks.block,
}));
vi.mock("../../dex-liquidity/source-pagination-state", () => ({
  readDexSourcePaginationState: vi.fn(async () => ({ cursor: null, cycleStartedAt: null })),
  writeDexSourcePaginationState: vi.fn(async () => ({ written: true })),
}));

beforeEach(() => {
  mocks.load.mockReset();
  mocks.block.mockReset().mockResolvedValue(null);
  mocks.publish.mockReset().mockImplementation(async ({ generationId, outcomes }) => ({
    generationId, measuredCount: 0, failedCount: outcomes.length,
  }));
});

function catalog(targets: DexMeasuredExecutionTarget[]) {
  return { generationId: "pre-retirement-shadow-targets", publishedAt: 1_000, targets };
}

const retired = [
  makeV3Target({ adapterProfileId: "hybra-v3-quoter-v2", protocol: "hybra-finance-v3", chain: "hyperevm" }),
  makeV3Target({ adapterProfileId: "xswap-v3-quoter-v2", protocol: "xswap-v3", chain: "xdc" }),
  makeV3Target({ adapterProfileId: "uniswap-v4-hook-free-quoter-v1", protocol: "uniswap-v4", chain: "unichain" }),
  makeV3Target({ chain: "ethereum" }),
];

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
