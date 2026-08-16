import { describe, expect, it, vi } from "vitest";

import type { EvmMulticall3Result } from "../../../lib/evm-rpc";
import {
  executeEvmQuotePlan,
  materializeEvmQuotePoint,
  type EvmQuotePlanItem,
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
