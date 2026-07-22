import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CircuitOutcomeRecord } from "../circuit-breaker";

const circuitMocks = vi.hoisted(() => ({
  allowed: true,
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcomeSafe: vi.fn(async (_db: D1Database, source: string, success: boolean): Promise<CircuitOutcomeRecord> => ({
    before: {
      state: success ? "half-open" : "closed",
      consecutiveFailures: success ? 1 : 0,
      lastFailureAt: success ? 10 : null,
      lastSuccessAt: null,
      openedAt: success ? 10 : null,
    },
    after: {
      state: success ? "closed" : "open",
      consecutiveFailures: success ? 0 : 1,
      lastFailureAt: success ? 10 : 20,
      lastSuccessAt: success ? 20 : null,
      openedAt: success ? null : 20,
    },
  })),
}));

vi.mock("../circuit-breaker", () => ({
  shouldAttemptFetch: circuitMocks.shouldAttemptFetch,
  recordOutcomeSafe: circuitMocks.recordOutcomeSafe,
}));

import {
  ProviderCircuitOpenError,
  ProviderExecutionError,
  createProviderExecutionContext,
  createProviderExecutionContextForJob,
  providerJson,
  providerTextBounded,
  withProviderExecution,
  type ProviderExecutionPolicy,
} from "../provider-execution";

function makePolicy(overrides: Partial<ProviderExecutionPolicy<string>> = {}): ProviderExecutionPolicy<string> {
  return {
    providerId: "test-provider",
    maxConcurrent: 5,
    timeoutMs: 5_000,
    countsAgainstLaneBudget: true,
    responseBodyPolicy: "cancel",
    ...overrides,
  };
}

function neverEndingResponse(prefix = ""): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) {
        controller.enqueue(encoder.encode(prefix));
      }
    },
  }));
}

describe("provider-execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    circuitMocks.shouldAttemptFetch.mockReset();
    circuitMocks.recordOutcomeSafe.mockClear();
    circuitMocks.shouldAttemptFetch.mockImplementation(async () => circuitMocks.allowed);
    circuitMocks.allowed = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bounds concurrent work by the lane budget", async () => {
    const context = createProviderExecutionContext({
      laneId: "unit-lane",
      laneMaxConcurrent: 2,
    });
    let active = 0;
    let maxActive = 0;

    await Promise.all(Array.from({ length: 6 }, (_unused, index) =>
      withProviderExecution(context, makePolicy({ providerId: `provider-${index}` }), async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return "ok";
      }),
    ));

    expect(maxActive).toBe(2);
    expect(context.snapshot().lane.inUse).toBe(0);
  });

  it("bounds concurrent work by provider policy", async () => {
    const context = createProviderExecutionContext({
      laneId: "unit-lane",
      laneMaxConcurrent: 5,
    });
    let active = 0;
    let maxActive = 0;

    await Promise.all(Array.from({ length: 4 }, () =>
      withProviderExecution(context, makePolicy({ maxConcurrent: 1 }), async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return "ok";
      }),
    ));

    expect(maxActive).toBe(1);
    expect(context.snapshot().providers["test-provider"]?.inUse).toBe(0);
  });

  it("blocks execution when the provider circuit is open", async () => {
    circuitMocks.allowed = false;
    const context = createProviderExecutionContext({
      laneId: "unit-lane",
      laneMaxConcurrent: 1,
      db: {} as D1Database,
    });
    const operation = vi.fn(async () => "unused");

    await expect(
      withProviderExecution(
        context,
        makePolicy({ breakerPolicy: { circuitKey: "test-provider" } }),
        operation,
      ),
    ).rejects.toBeInstanceOf(ProviderCircuitOpenError);

    expect(operation).not.toHaveBeenCalled();
    expect(circuitMocks.recordOutcomeSafe).not.toHaveBeenCalled();
  });

  it("records classified provider outcomes through the circuit breaker", async () => {
    const context = createProviderExecutionContext({
      laneId: "unit-lane",
      laneMaxConcurrent: 1,
      db: {} as D1Database,
    });

    const result = await withProviderExecution(
      context,
      makePolicy({
        breakerPolicy: { circuitKey: "test-provider" },
        classifyOutcome: () => "failure",
      }),
      async () => "degraded",
    );

    expect(result.circuitOutcome?.after.state).toBe("open");
    expect(circuitMocks.recordOutcomeSafe).toHaveBeenCalledWith(
      context.db,
      "test-provider",
      false,
    );
  });

  it("records sub-second duration from the monotonic clock", async () => {
    const nowSpy = vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(137.5);
    const context = createProviderExecutionContext({
      laneId: "duration-lane",
      laneMaxConcurrent: 1,
    });

    const result = await withProviderExecution(
      context,
      makePolicy(),
      async () => "ok",
    );

    expect(result.attempt.durationMs).toBe(37.5);
    nowSpy.mockRestore();
  });

  it("records timed-out degraded results as provider failures", async () => {
    vi.useFakeTimers();
    try {
      const context = createProviderExecutionContext({
        laneId: "unit-lane",
        laneMaxConcurrent: 1,
        db: {} as D1Database,
      });
      let operationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        operationStarted = resolve;
      });

      const resultPromise = withProviderExecution(
        context,
        makePolicy({
          breakerPolicy: { circuitKey: "test-provider" },
          timeoutMs: 5,
          classifyOutcome: () => "success",
        }),
        async ({ signal }) => {
          operationStarted();
          return await new Promise<string>((resolve) => {
            signal.addEventListener("abort", () => resolve("degraded"), { once: true });
          });
        },
      );

      await started;
      await vi.advanceTimersByTimeAsync(5);
      const result = await resultPromise;

      expect(result.value).toBe("degraded");
      expect(result.attempt.timedOut).toBe(true);
      expect(result.attempt.outcome).toBe("failure");
      expect(circuitMocks.recordOutcomeSafe).toHaveBeenCalledWith(
        context.db,
        "test-provider",
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts queued provider work while waiting for a lane permit", async () => {
    const controller = new AbortController();
    const context = createProviderExecutionContext({
      laneId: "unit-lane",
      laneMaxConcurrent: 1,
      signal: controller.signal,
    });

    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const first = withProviderExecution(context, makePolicy({ providerId: "first-provider" }), async ({ signal }) => {
      startedFirst();
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve("ok"), 1_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      });
    });
    await firstStarted;

    const second = withProviderExecution(context, makePolicy({ providerId: "second-provider" }), async () => "unused");
    await Promise.resolve();
    expect(context.snapshot().lane.queued).toBe(1);

    controller.abort(new Error("cron aborted"));

    await expect(second).rejects.toThrow("cron aborted");
    await expect(first).rejects.toThrow("cron aborted");
    expect(context.snapshot().lane).toMatchObject({ inUse: 0, queued: 0 });
  });

  it("records non-OK providerJson responses as failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    const context = createProviderExecutionContext({
      laneId: "unit-lane",
      laneMaxConcurrent: 1,
      db: {} as D1Database,
    });

    await expect(
      providerJson(
        context,
        {
          providerId: "json-provider",
          maxConcurrent: 1,
          timeoutMs: 5_000,
          responseBodyPolicy: "consume",
          breakerPolicy: { circuitKey: "json-provider" },
        },
        "https://example.com/provider.json",
      ),
    ).rejects.toBeInstanceOf(ProviderExecutionError);

    expect(circuitMocks.recordOutcomeSafe).toHaveBeenCalledWith(
      context.db,
      "json-provider",
      false,
    );
  });

  it("treats providerJson body timeouts as provider execution failures", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => neverEndingResponse("{")));
      const context = createProviderExecutionContext({
        laneId: "unit-lane",
        laneMaxConcurrent: 1,
      });

      const resultPromise = providerJson(
        context,
        {
          providerId: "json-provider",
          maxConcurrent: 1,
          timeoutMs: 5,
          responseBodyPolicy: "consume",
        },
        "https://example.com/provider.json",
      );

      const expectation = expect(resultPromise).rejects.toMatchObject({
        name: "ProviderExecutionError",
        attempt: {
          providerId: "json-provider",
          timedOut: true,
          outcome: "failure",
          httpStatus: 200,
        },
      });
      await vi.advanceTimersByTimeAsync(5);
      await expectation;
      expect(context.snapshot().lane.inUse).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats providerTextBounded body timeouts as provider execution failures", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => neverEndingResponse("partial")));
      const context = createProviderExecutionContext({
        laneId: "unit-lane",
        laneMaxConcurrent: 1,
      });

      const resultPromise = providerTextBounded(
        context,
        {
          providerId: "text-provider",
          maxConcurrent: 1,
          timeoutMs: 5,
          responseBodyPolicy: "consume",
        },
        "https://example.com/provider.txt",
      );

      const expectation = expect(resultPromise).rejects.toMatchObject({
        name: "ProviderExecutionError",
        attempt: {
          providerId: "text-provider",
          timedOut: true,
          outcome: "failure",
          httpStatus: 200,
        },
      });
      await vi.advanceTimersByTimeAsync(5);
      await expectation;
      expect(context.snapshot().lane.inUse).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives scheduled provider context limits from cron connection metadata", () => {
    const context = createProviderExecutionContextForJob({
      job: "sync-dex-liquidity",
      laneId: "dex-direct-api",
      laneMaxConcurrent: 2,
    });

    expect(context.laneMaxConcurrent).toBe(2);
    expect(() =>
      createProviderExecutionContextForJob({
        job: "sync-dex-liquidity",
        laneMaxConcurrent: 6,
      }),
    ).toThrow(/declared job budget is 5/);
  });
});
