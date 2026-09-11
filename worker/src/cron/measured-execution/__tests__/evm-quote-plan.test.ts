import { describe, expect, it, vi } from "vitest";

import type { EvmMulticall3Result } from "../../../lib/evm-rpc";
import {
  executeEvmQuotePlan,
  materializeEvmQuotePoint,
  type EvmQuotePlanItem,
  type EvmQuotePlanBatchInput,
} from "../evm-quote-plan";

interface TestPlan extends EvmQuotePlanItem {
  value: number;
}

function plan(index: number, chain: string, blockNumber: number): TestPlan {
  const label = `${index}:target`;
  return {
    index,
    label,
    chain,
    blockNumber,
    value: index,
    call: {
      label,
      target: "0x1111111111111111111111111111111111111111",
      callData: "0x1234",
      allowFailure: true,
    },
  };
}

describe("EVM quote-plan executor", () => {
  it("groups pinned blocks inside at most three serialized chain lanes", async () => {
    let active = 0;
    let peak = 0;
    const activeByChain = new Map<string, number>();
    const executeMulticall = vi.fn(async (input: { chain: string; calls: readonly { label: string }[] }) => {
      active += 1;
      peak = Math.max(peak, active);
      activeByChain.set(input.chain, (activeByChain.get(input.chain) ?? 0) + 1);
      expect(activeByChain.get(input.chain)).toBe(1);
      await Promise.resolve();
      activeByChain.set(input.chain, activeByChain.get(input.chain)! - 1);
      active -= 1;
      return input.calls.map((call): EvmMulticall3Result => ({
        label: call.label,
        success: true,
        returnData: "0x01",
      }));
    });
    const plans = [
      plan(0, "ethereum", 1),
      plan(1, "ethereum", 2),
      plan(2, "base", 1),
      plan(3, "arbitrum", 1),
      plan(4, "polygon", 1),
    ];

    const outcomes = await executeEvmQuotePlan({
      plans,
      outcomes: plans.map(() => "pending"),
      chainRpcs: new Map(),
      spec: {
        batchSize: 1,
        executeMulticall,
        resolveResult: (item) => `ok:${item.value}`,
        materializeTransportFailure: () => "failed",
      },
    });

    expect(outcomes).toEqual(["ok:0", "ok:1", "ok:2", "ok:3", "ok:4"]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("maps labeled results instead of relying on RPC response order", async () => {
    const plans = [plan(0, "ethereum", 1), plan(1, "ethereum", 1)];
    const outcomes = await executeEvmQuotePlan({
      plans,
      outcomes: ["pending", "pending"],
      chainRpcs: new Map(),
      spec: {
        batchSize: 8,
        executeMulticall: async ({ calls }) => [...calls].reverse().map((call) => ({
          label: call.label,
          success: true,
          returnData: "0x01" as const,
        })),
        resolveResult: (item, result) => `${item.index}:${result.label}`,
        materializeTransportFailure: () => "failed",
      },
    });

    expect(outcomes).toEqual(["0:0:target", "1:1:target"]);
  });

  it("materializes a protocol preflight failure for the whole pinned-block group", async () => {
    const plans = [plan(0, "ethereum", 1), plan(1, "ethereum", 1)];
    const executeMulticall = vi.fn();
    const outcomes = await executeEvmQuotePlan({
      plans,
      outcomes: ["pending", "pending"],
      chainRpcs: new Map(),
      spec: {
        batchSize: 8,
        beforeBlock: async () => ({
          ok: false,
          materialize: (item) => `preflight-failed:${item.index}`,
        }),
        executeMulticall,
        resolveResult: () => "ok",
        materializeTransportFailure: () => "transport-failed",
      },
    });

    expect(executeMulticall).not.toHaveBeenCalled();
    expect(outcomes).toEqual(["preflight-failed:0", "preflight-failed:1"]);
  });

  it("isolates missing labels and null transports by pinned block and chain", async () => {
    const plans = [plan(0, "ethereum", 10), plan(1, "ethereum", 11),
      plan(2, "ethereum", 10), plan(3, "base", 10), plan(4, "ethereum", 12)];
    const executeMulticall = vi.fn(async ({ chain, blockNumber, calls }: EvmQuotePlanBatchInput) =>
      chain === "ethereum" && blockNumber === 11 ? null : calls
        .filter((call) => call.label !== "2:target")
        .map((call) => ({ label: call.label, success: true, returnData: "0x01" as const })),
    );
    const outcomes = await executeEvmQuotePlan({
      plans, outcomes: plans.map(() => "pending"), chainRpcs: new Map(),
      spec: { batchSize: 8, executeMulticall,
        resolveResult: (item) => `ok:${item.index}`,
        materializeTransportFailure: (item) => `failed:${item.index}` },
    });
    expect(outcomes).toEqual(["ok:0", "failed:1", "failed:2", "ok:3", "ok:4"]);
    expect(executeMulticall.mock.calls.map(([input]) => [
      input.chain, input.blockNumber, input.calls.map((call: { label: string }) => call.label),
    ]).sort()).toEqual([
      ["base", 10, ["3:target"]],
      ["ethereum", 10, ["0:target", "2:target"]],
      ["ethereum", 11, ["1:target"]],
      ["ethereum", 12, ["4:target"]],
    ]);
  });

  it.each(["before execution", "between batches"])("aborts %s without subsequent RPC work", async (when) => {
    const controller = new AbortController();
    const reason = new Error("cancel quote plan");
    if (when === "before execution") controller.abort(reason);
    const executeMulticall = vi.fn(async ({ calls }: EvmQuotePlanBatchInput) => {
      controller.abort(reason);
      return calls.map((call) => ({
        label: call.label, success: true, returnData: "0x01" as const,
      }));
    });
    await expect(executeEvmQuotePlan({
      plans: [plan(0, "ethereum", 10), plan(1, "ethereum", 10)],
      outcomes: ["pending", "pending"], chainRpcs: new Map(), signal: controller.signal,
      spec: { batchSize: 1, executeMulticall, resolveResult: () => "ok",
        materializeTransportFailure: () => "failed" },
    })).rejects.toThrow(reason);
    expect(executeMulticall).toHaveBeenCalledTimes(when === "before execution" ? 0 : 1);
  });

  it("rejects invalid batch sizes before executing work", async () => {
    const executeMulticall = vi.fn();
    for (const batchSize of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(executeEvmQuotePlan({
        plans: [plan(0, "ethereum", 10)], outcomes: ["pending"], chainRpcs: new Map(),
        spec: { batchSize, executeMulticall, resolveResult: () => "ok",
          materializeTransportFailure: () => "failed" },
      })).rejects.toThrow(TypeError);
    }
    expect(executeMulticall).not.toHaveBeenCalled();
  });

  it("converts raw amounts to USD and clamps favorable execution cost at zero", () => {
    expect(materializeEvmQuotePoint({
      amountInRaw: 100_000_000n,
      amountOutRaw: 101_000_000n,
      callData: "0xABCD",
      returnData: "0xEF",
      tokenIn: { decimals: 6, referencePriceUsd: 1 },
      tokenOut: { decimals: 6, referencePriceUsd: 1 },
      adapterMetadata: { protocol: "test" },
    })).toMatchObject({
      inputUsd: 100,
      outputUsd: 101,
      costBps: 0,
      passesCostBound: true,
      callData: "0xabcd",
      returnData: "0xef",
    });
  });
});
