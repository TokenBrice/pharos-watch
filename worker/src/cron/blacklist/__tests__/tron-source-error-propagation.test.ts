import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../lib/abort", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/abort")>();
  return {
    ...actual,
    sleepWithSignal: vi.fn(async (_ms: number, signal?: AbortSignal) => {
      actual.throwIfAborted(signal);
    }),
  };
});

import { fetchTronEventsIncremental } from "../tron-source";
import { createBudget, type RateLimitedFetch } from "../../../lib/evm-logs";
import type { BlacklistRunBudget } from "../../../lib/blacklist/run-budget";

const noopLimiter: RateLimitedFetch = (fn) => fn();

const configStub = {
  configKey: "tron-test",
  chain: { chainId: "tron", chainName: "Tron", evmChainId: null, explorerUrl: "https://tronscan.org", type: "tron" as const },
  stablecoinId: "usdt-tether",
  stablecoin: "USDT" as const,
  contractAddress: "TRX...",
  decimals: 6,
  events: [
    { signature: "AddedBlackList(address)", topicHash: "0x0", eventType: "blacklist" as const, hasAmount: false },
  ],
};

describe("fetchTronEventsIncremental error propagation", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  function makeRunBudget(): BlacklistRunBudget {
    return {
      subrequestBudget: createBudget(100),
      deadlineMs: Date.now() + 60_000,
      minimumConfigWindowMs: 0,
    };
  }

  it("returns apiError=true when TronGrid responds with HTTP 500", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("server error", { status: 500 }),
    );
    const result = await fetchTronEventsIncremental(
      configStub,
      null,
      0,
      makeRunBudget(),
      noopLimiter,
      undefined,
    );
    expect(result.apiError).toBe(true);
    expect(result.rows).toHaveLength(0);
  });

  it("returns apiError=true when TronGrid returns success=false", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: false, data: [] }), { status: 200 }),
    );
    const result = await fetchTronEventsIncremental(
      configStub,
      null,
      0,
      makeRunBudget(),
      noopLimiter,
      undefined,
    );
    expect(result.apiError).toBe(true);
  });

  it("returns apiError=true when TronGrid payload fails Zod validation", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ data: "oops" }), { status: 200 }),
    );
    const result = await fetchTronEventsIncremental(
      configStub,
      null,
      0,
      makeRunBudget(),
      noopLimiter,
      undefined,
    );
    expect(result.apiError).toBe(true);
    expect(result.rows).toHaveLength(0);
  });

  it("returns apiError=false on success", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );
    const result = await fetchTronEventsIncremental(
      configStub,
      null,
      0,
      makeRunBudget(),
      noopLimiter,
      undefined,
    );
    expect(result.apiError).toBe(false);
  });
});
