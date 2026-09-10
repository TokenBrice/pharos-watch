import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDexApiFetchResult,
  type DexApiPool,
} from "../../../lib/dex-api-common";
import { recordOutcomeSafe } from "../../../lib/circuit-breaker";
import type { DirectApiFetcher } from "../orchestrator-phases/direct-api";
import {
  buildAttemptedProtocolChains,
  buildDexDirectApiFetchers,
  compactDirectApiFetchPhasePools,
  runDirectApiFetchPhase,
} from "../orchestrator-phases/direct-api";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";
import { DIRECT_API_PROVIDER_TIMEOUT_MS } from "../direct-api-policy";
import { buildChainAddressKey } from "../token-resolution";

type MockCircuitRecord = {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
};

const circuitStore = vi.hoisted(() => ({
  nowSec: 1_800_000_000,
  records: new Map<string, MockCircuitRecord>(),
}));


vi.mock("../../../lib/circuit-breaker", () => {
  const defaultRecord = (): MockCircuitRecord => ({
    state: "closed",
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
  });

  function cloneRecord(record: MockCircuitRecord): MockCircuitRecord {
    return { ...record };
  }

  return {
    getCircuitRecord: vi.fn(async (_db: D1Database, source: string) =>
      cloneRecord(circuitStore.records.get(source) ?? defaultRecord()),
    ),
    shouldAttemptFetch: vi.fn(async (_db: D1Database, source: string) =>
      (circuitStore.records.get(source) ?? defaultRecord()).state !== "open",
    ),
    recordOutcomeSafe: vi.fn(async (_db: D1Database, source: string, success: boolean) => {
      const current = cloneRecord(circuitStore.records.get(source) ?? defaultRecord());
      if (success) {
        const after = {
          ...current,
          state: "closed",
          consecutiveFailures: 0,
          lastSuccessAt: circuitStore.nowSec,
          openedAt: null,
        } satisfies MockCircuitRecord;
        circuitStore.records.set(source, after);
        return { before: current, after: cloneRecord(after) };
      }
      const after = {
        ...current,
        state: "open",
        consecutiveFailures: current.consecutiveFailures + 1,
        lastFailureAt: circuitStore.nowSec,
        openedAt: circuitStore.nowSec,
      } satisfies MockCircuitRecord;
      circuitStore.records.set(source, after);
      return { before: current, after: cloneRecord(after) };
    }),
  };
});

function makeFetcher(name: string, fn: DirectApiFetcher["fn"]): DirectApiFetcher {
  return {
    name,
    circuitKey: `${name.toLowerCase()}-circuit`,
    normalizedProtocol: name.toLowerCase(),
    supportedChains: ["testnet"],
    fn,
  };
}

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = () => promiseResolve();
  });
  return { promise, resolve };
}

describe("runDirectApiFetchPhase", () => {
  beforeEach(() => {
    circuitStore.records.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs providers serially and completes each before starting the next", async () => {
    const names = ["one", "two", "three", "four"];
    const starts = names.map(() => makeDeferred());
    const releases = names.map(() => makeDeferred());
    const started: string[] = [];
    const fetchers = names.map((name, index) => makeFetcher(name, async () => {
      started.push(name);
      starts[index].resolve();
      await releases[index].promise;
      return makeDexApiFetchResult([], { ok: true, degraded: false, errors: [] });
    }));
    const pending = runDirectApiFetchPhase({} as D1Database, fetchers);
    try {
      for (let index = 0; index < names.length; index++) {
        await starts[index].promise;
        expect(started).toEqual(names.slice(0, index + 1));
        releases[index].resolve();
      }
      const result = await pending;
      expect(result.results.map((entry) => entry.name)).toEqual(names);
      expect(result.failedSources).toEqual([]);
      expect(result.fallbackSignals).toEqual([]);
    } finally {
      releases.forEach((release) => release.resolve());
      await pending;
    }
  });

  it("compacts each provider before starting the next while retaining raw counts and exact-key evidence", async () => {
    const rawPoolCount = 4;
    const trackedAddress = "0x1111111111111111111111111111111111111111";
    const makePool = (index: number, tracked: boolean): DexApiPool => ({
      source: "balancer",
      chain: "ethereum",
      poolAddress: `0x${index.toString(16).padStart(40, "0")}`,
      poolType: "balancer-stable",
      tokens: [
        {
          address: tracked ? trackedAddress : `0x${(index + 1_000).toString(16).padStart(40, "0")}`,
          symbol: tracked ? "TRACKED" : "UNKNOWN",
          decimals: 6,
        },
        {
          address: `0x${(index + 2_000).toString(16).padStart(40, "0")}`,
          symbol: "QUOTE",
          decimals: 6,
        },
      ],
      price: 1,
      tvlUsd: 1_000_000,
      volume24hUsd: 50_000,
      feeRate: null,
      balances: [500_000, 500_000],
    });
    const firstResult = makeDexApiFetchResult(
      [
        makePool(1, true),
        ...Array.from({ length: rawPoolCount - 1 }, (_, index) => makePool(index + 2, false)),
      ],
      { ok: true, degraded: false, errors: [] },
    );
    const lookups = {
      chainAddressToId: new Map([
        [buildChainAddressKey("ethereum", trackedAddress), "tracked-stablecoin"],
      ]),
      symbolToChainScopedIds: new Map<string, Map<string, string[]>>(),
      contractMetaByChainAddress: new Map(),
    };
    let poolsAtSecondProviderEntry: number | undefined;
    const fetchers = [
      makeFetcher("first", async () => firstResult),
      makeFetcher("second", async () => {
        poolsAtSecondProviderEntry = firstResult.pools.length;
        return makeDexApiFetchResult([], { ok: true, degraded: false, errors: [] });
      }),
    ];

    const phase = await runDirectApiFetchPhase({} as D1Database, fetchers, undefined, lookups);
    const compacted = compactDirectApiFetchPhasePools(phase, lookups);
    const authoritative = buildAuthoritativeStagedPoolConfirmationIndex(compacted.phase.results);

    expect(compacted.counts).toEqual({
      rawPoolCount,
      retainedPoolCount: 1,
      skippedInvalidUnitCount: 0,
      skippedUntrackedCount: rawPoolCount - 1,
    });
    expect(poolsAtSecondProviderEntry).toBe(1);
    expect(phase.results.find((entry) => entry.name === "second")?.result.ok).toBe(true);
    expect(phase.failedSources).toEqual([]);
    expect(compacted.pools.map((pool) => pool.poolAddress)).toEqual([
      "0x0000000000000000000000000000000000000001",
    ]);
    expect(authoritative.confirmedExactKeysByProtocol.get("first")).toContain(
      "ethereum:0x0000000000000000000000000000000000000004",
    );
  });

  it("reports circuit close events after a half-open source recovers", async () => {
    circuitStore.records.set("recovering-circuit", {
      state: "half-open",
      consecutiveFailures: 3,
      lastFailureAt: 1_799_999_900,
      lastSuccessAt: null,
      openedAt: 1_799_999_900,
    });
    const fetchers = [
      makeFetcher("recovering", async () =>
        makeDexApiFetchResult([], { ok: true, degraded: false, errors: [] }),
      ),
    ];

    const result = await runDirectApiFetchPhase({} as D1Database, fetchers);

    expect(result.circuitEvents).toEqual([
      {
        circuitKey: "recovering-circuit",
        from: "half-open",
        to: "closed",
        at: 1_800_000_000,
      },
    ]);
  });

  it("skips an open provider circuit without invoking its fetcher", async () => {
    circuitStore.records.set("blocked-circuit", {
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: 1_799_999_900,
      lastSuccessAt: null,
      openedAt: 1_799_999_900,
    });
    const fn = vi.fn(async () =>
      makeDexApiFetchResult([], { ok: true, degraded: false, errors: [] })
    );

    const result = await runDirectApiFetchPhase(
      {} as D1Database,
      [makeFetcher("blocked", fn)],
    );

    expect(fn).not.toHaveBeenCalled();
    expect(result.failedSources).toEqual(["blocked-circuit"]);
    expect(result.fallbackSignals).toEqual(["blocked-circuit-circuit-open"]);
    expect(result.results[0]?.result.errors).toEqual(["circuit open"]);
    expect(recordOutcomeSafe).not.toHaveBeenCalled();
  });

  it("records thrown provider failures and keeps them non-fatal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runDirectApiFetchPhase(
      {} as D1Database,
      [makeFetcher("broken", async () => {
        throw new Error("upstream broke");
      })],
    );

    expect(result.failedSources).toEqual(["broken-circuit"]);
    expect(result.fallbackSignals).toEqual(["broken-circuit-exception"]);
    expect(result.circuitEvents).toEqual([{
      circuitKey: "broken-circuit",
      from: "closed",
      to: "open",
      at: 1_800_000_000,
    }]);
    expect(result.results[0]?.result.errors).toEqual([
      "Provider dex-direct-api:broken failed: upstream broke",
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("records the outer provider timeout as a circuit failure", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let started!: () => void;
      const operationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const resultPromise = runDirectApiFetchPhase(
        {} as D1Database,
        [makeFetcher("slow", async (signal) => {
          started();
          return await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        })],
      );

      await operationStarted;
      await vi.advanceTimersByTimeAsync(DIRECT_API_PROVIDER_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result.failedSources).toEqual(["slow-circuit"]);
      expect(result.fallbackSignals).toEqual(["slow-circuit-exception"]);
      expect(result.circuitEvents[0]).toMatchObject({
        circuitKey: "slow-circuit",
        from: "closed",
        to: "open",
      });
      expect(result.results[0]?.result.errors[0]).toContain(
        `provider dex-direct-api:slow timed out after ${DIRECT_API_PROVIDER_TIMEOUT_MS}ms`,
      );
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rethrows a parent abort without recording a provider failure", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resultPromise = runDirectApiFetchPhase(
      {} as D1Database,
      [makeFetcher("aborted", async (signal) => {
        started();
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })],
      controller.signal,
    );

    await operationStarted;
    controller.abort(new Error("cron aborted"));

    await expect(resultPromise).rejects.toThrow("cron aborted");
    expect(recordOutcomeSafe).not.toHaveBeenCalled();
  });

  it("does not mark warning-only direct API results as failed", async () => {
    const fetchers = [
      makeFetcher("warning-only", async () =>
        makeDexApiFetchResult([], {
          ok: true,
          degraded: false,
          errors: [],
          warnings: ["retained pool enrichment failed"],
        }),
      ),
    ];

    const result = await runDirectApiFetchPhase({} as D1Database, fetchers);

    expect(result.failedSources).toEqual([]);
    expect(result.fallbackSignals).toEqual([]);
    expect(result.sourceWarnings).toEqual(["warning-only-circuit: retained pool enrichment failed"]);
    expect(result.results[0]?.result.warnings).toEqual(["retained pool enrichment failed"]);
  });

  it("keeps partially usable direct API results out of failed sources", async () => {
    const fetchers = [
      makeFetcher("mixed", async () =>
        makeDexApiFetchResult([], {
          ok: true,
          degraded: true,
          errors: ["page 2 returned 503"],
          warnings: ["page 1 skipped 1 malformed pool rows"],
        }),
      ),
    ];

    const result = await runDirectApiFetchPhase({} as D1Database, fetchers);

    expect(result.failedSources).toEqual([]);
    expect(result.fallbackSignals).toEqual(["mixed-circuit-partial"]);
    expect(result.sourceWarnings).toEqual([
      "mixed-circuit: page 1 skipped 1 malformed pool rows",
      "mixed-circuit: page 2 returned 503",
    ]);
    expect(result.results[0]?.result.errors).toEqual(["page 2 returned 503"]);
    expect(result.results[0]?.result.warnings).toEqual(["page 1 skipped 1 malformed pool rows"]);
    expect(recordOutcomeSafe).toHaveBeenCalledWith(expect.anything(), "mixed-circuit", true);
  });

  it("marks an unavailable direct API result as failed", async () => {
    const fetchers = [
      makeFetcher("unavailable", async () =>
        makeDexApiFetchResult([], {
          ok: false,
          degraded: true,
          errors: ["all pages returned 503"],
        }),
      ),
    ];

    const result = await runDirectApiFetchPhase({} as D1Database, fetchers);

    expect(result.failedSources).toEqual(["unavailable-circuit"]);
    expect(result.degradedSources).toEqual([]);
    expect(result.fallbackSignals).toEqual(["unavailable-circuit-unavailable"]);
    expect(result.sourceWarnings).toEqual(["unavailable-circuit: all pages returned 503"]);
  });

  it("names the chain that failed inside an otherwise usable source", async () => {
    const fetchers: DirectApiFetcher[] = [
      {
        name: "PancakeSwap",
        circuitKey: "pancakeswap-api",
        normalizedProtocol: "pancakeswap",
        supportedChains: ["bsc", "ethereum", "base"],
        fn: async () =>
          makeDexApiFetchResult([], {
            ok: true,
            degraded: true,
            errors: ["bsc: The operation was aborted due to timeout"],
            degradedChains: ["bsc"],
          }),
      },
    ];

    const result = await runDirectApiFetchPhase({} as D1Database, fetchers);

    expect(result.failedSources).toEqual([]);
    expect(result.degradedSources).toEqual(["pancakeswap-api:bsc"]);
    expect(result.fallbackSignals).toEqual(["pancakeswap-api-partial"]);
    expect(result.attemptedProtocolChains).toEqual([
      "pancakeswap:bsc",
      "pancakeswap:ethereum",
      "pancakeswap:base",
    ]);
  });

  it("keeps a degraded source without chain detail at source level", async () => {
    const fetchers = [
      makeFetcher("cursorless", async () =>
        makeDexApiFetchResult([], {
          ok: true,
          degraded: true,
          errors: [],
        }),
      ),
    ];

    const result = await runDirectApiFetchPhase({} as D1Database, fetchers);

    expect(result.degradedSources).toEqual(["cursorless-circuit"]);
  });

  it("keys attempted coverage by the pool source family each adapter emits", () => {
    const fetchers = buildDexDirectApiFetchers({
      db: {} as D1Database,
      graphApiKey: "graph-key",
      chainAddressToId: new Map(),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map(),
    });

    // Slipstream and CLMM adapters emit a `source` that differs from their
    // normalized protocol; attempted keys must match the counts that
    // `acceptedByProtocolChain` records for the same pools.
    expect(buildAttemptedProtocolChains(fetchers)).toEqual(expect.arrayContaining([
      "pancakeswap:bsc",
      "pancakeswap:ethereum",
      "pancakeswap:base",
      "aerodrome-slipstream:base",
      "velodrome-slipstream:optimism",
      "raydium:solana",
      "orca:solana",
      "uniswap-v3-shadow:bsc",
    ]));
  });
});
