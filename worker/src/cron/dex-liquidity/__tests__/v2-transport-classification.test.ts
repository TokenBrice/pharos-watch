import { describe, expect, it, vi } from "vitest";
import { initMetrics } from "../pool-helpers";
import {
  EVM_V2_EXECUTION_DEPLOYMENTS,
  V2_ENRICHMENT_MAX_WALL_MS,
  enrichEvmV2ExecutionModels,
  resolveV2EnrichmentDeadlineMs,
} from "../constant-product-v2";
import type { PoolEntry } from "../types";
import {
  EVM_V2_REPLAY_BLOCK,
  EVM_V2_REPLAY_CASES,
  replayCandidate,
  replayMulticallResults,
  replayPool,
} from "./fixtures/evm-v2-fixtures";
import { captureRpcs, replayTokenLookups } from "./constant-product-v2.test-support";

interface MulticallResult {
  label: string;
  success: boolean;
  returnData: `0x${string}`;
}

const REPLAY = EVM_V2_REPLAY_CASES.find((entry) => entry.assetId === "spusd-soulpeg")!;

function blockHeader(blockNumber: number) {
  return {
    number: blockNumber,
    timestamp: 1_700_000_000,
    hash: `0x${"ab".repeat(32)}` as `0x${string}`,
  };
}

/**
 * The 2026-09-23 defect: a mid-run RPC transport failure gated staged V2
 * candidates `incomplete-exact-capture` — indistinguishable from a semantic
 * verification refusal — while every affected pool verified fine on chain.
 * Transport conditions now carry their own machine-readable gate reason, the
 * loop's wall time is bounded before any retry is issued, and each request
 * gains one network-only retry per URL.
 */
function makeEnrichment(options: {
  fetchMulticall?: (
    calls: readonly { label: string; target: string }[],
    rpcOptions: { maxRetries?: number; deadlineMs?: number } | undefined,
  ) => MulticallResult[] | null;
  fetchBlockNumber?: () => number | null;
  mutateResults?: (results: MulticallResult[]) => void;
}): {
  pool: PoolEntry;
  fetchMulticall: ReturnType<typeof vi.fn>;
  run: (extra?: { slotStartedAtSec?: number }) => Promise<void>;
} {
  const candidate = replayCandidate(REPLAY);
  const metric = initMetrics(REPLAY.assetId, REPLAY.stablecoinSymbol);
  const pool = replayPool(REPLAY, candidate);
  metric.topPools.push(pool);
  const { chainAddressToId, contractMetaByChainAddress } = replayTokenLookups(REPLAY);
  const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find(
    (entry) => entry.source === "pancakeswap-v2",
  )!;
  const fetchMulticall = vi.fn(
    async (
      _chain: string,
      calls: readonly { label: string; target: string }[],
      _blockNumber: number,
      rpcOptions?: { maxRetries?: number; deadlineMs?: number },
    ): Promise<MulticallResult[] | null> => {
      if (options.fetchMulticall != null) return options.fetchMulticall(calls, rpcOptions);
      const results = replayMulticallResults(REPLAY, calls) as MulticallResult[];
      options.mutateResults?.(results);
      return results;
    },
  );
  const run = (extra: { slotStartedAtSec?: number } = {}) =>
    enrichEvmV2ExecutionModels({
      metrics: new Map([[metric.stablecoinId, metric]]),
      chainAddressToId,
      contractMetaByChainAddress,
      stablecoinPriceById: new Map([
        [REPLAY.assetId, 1],
        [REPLAY.counterAssetId, 1],
      ]),
      chainRpcs: captureRpcs("bsc", "BSC"),
      dependencies: {
        fetchBlockNumber: vi.fn(async () =>
          options.fetchBlockNumber != null ? options.fetchBlockNumber() : EVM_V2_REPLAY_BLOCK),
        fetchBlockHeader: vi.fn(async (_chain: string, blockNumber: number | "finalized") =>
          blockHeader(blockNumber as number)),
        fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
        fetchMulticall: fetchMulticall as never,
        hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
      },
      ...extra,
    });
  return { pool, fetchMulticall, run };
}

describe("EVM V2 verification transport classification", () => {
  it("gates a request-level transport failure as transport-unavailable, not a capture refusal", async () => {
    const harness = makeEnrichment({ fetchMulticall: () => null });
    await harness.run();

    expect(harness.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(harness.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "transport-unavailable",
    });
  });

  it("gates an unavailable pinned block as transport-unavailable", async () => {
    const harness = makeEnrichment({ fetchBlockNumber: () => null });
    await harness.run();

    expect(harness.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "transport-unavailable",
    });
  });

  it("keeps semantic refusals on their specific reasons", async () => {
    // The factory resolves the token pair to a different pool: observed data,
    // semantically refused.
    const mismatched = makeEnrichment({
      mutateResults: (results) => {
        for (const result of results) {
          if (result.label.endsWith("-pair")) {
            result.returnData = `0x${"9f".repeat(32)}` as `0x${string}`;
          }
        }
      },
    });
    await mismatched.run();
    expect(mismatched.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "exact-pool-join-unresolved",
    });

    // A returned-but-malformed reserves word is an observed capture that is
    // incomplete: still incomplete-exact-capture, never transport.
    const malformed = makeEnrichment({
      mutateResults: (results) => {
        for (const result of results) {
          if (result.label.endsWith("-reserves")) {
            result.returnData = `${result.returnData}00` as `0x${string}`;
          }
        }
      },
    });
    await malformed.run();
    expect(malformed.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "incomplete-exact-capture",
    });
  });

  it("bounds the loop's wall time before issuing or retrying requests", async () => {
    vi.useFakeTimers();
    const nowMs = Date.now();
    try {
      // A slot start far in the past makes the resolved deadline expired, so
      // the batch loop must gate every probe without issuing any multicall.
      const expiredSlotSec = Math.floor(nowMs / 1000) - 3_600;
      const harness = makeEnrichment({});
      await harness.run({ slotStartedAtSec: expiredSlotSec });

      expect(harness.fetchMulticall).not.toHaveBeenCalled();
      expect(harness.pool.extra?.executionCapabilityGate).toEqual({
        family: "constant-product-v2",
        reason: "transport-unavailable",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries one network-only retry and a bounded deadline on every verification request", async () => {
    const harness = makeEnrichment({});
    const beforeMs = Date.now();
    await harness.run();
    const afterMs = Date.now();

    expect(harness.fetchMulticall).toHaveBeenCalled();
    for (const call of harness.fetchMulticall.mock.calls) {
      expect(call[3]?.maxRetries).toBe(1);
      const deadlineMs = call[3]?.deadlineMs;
      expect(typeof deadlineMs).toBe("number");
      expect(deadlineMs!).toBeGreaterThanOrEqual(beforeMs);
      expect(deadlineMs!).toBeLessThanOrEqual(afterMs + V2_ENRICHMENT_MAX_WALL_MS);
    }
  });

  it("resolves the enrichment deadline as the earlier of the slot budget and the loop cap", () => {
    const nowMs = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const slotSec = Math.floor(nowMs / 1000);
    const withSlot = resolveV2EnrichmentDeadlineMs(slotSec);
    expect(withSlot).toBeLessThanOrEqual(nowMs + V2_ENRICHMENT_MAX_WALL_MS);
    expect(withSlot).toBeGreaterThan(nowMs);

    // No slot context: the standalone loop cap bounds the deadline.
    const noSlot = resolveV2EnrichmentDeadlineMs(undefined);
    expect(noSlot).toBeGreaterThan(nowMs);
    expect(noSlot).toBeLessThanOrEqual(nowMs + V2_ENRICHMENT_MAX_WALL_MS);
    vi.restoreAllMocks();
  });
});
