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
      undefined,
    );
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
      undefined,
    );
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
