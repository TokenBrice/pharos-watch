import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDexApiFetchResult,
  normalizeDexApiPoolsForMerge,
  type DexApiPool,
} from "../../../lib/dex-api-common";
import { getCircuitRecord } from "../../../lib/circuit-breaker";
import type { DirectApiFetcher } from "../orchestrator-phases/direct-api";
import {
  compactDirectApiFetchPhasePools,
  runDirectApiFetchPhase,
} from "../orchestrator-phases/direct-api";
import { buildAuthoritativeStagedPoolConfirmationIndex } from "../orchestrator-phases/authoritative";
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

vi.mock("../../../lib/dex-api-common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/dex-api-common")>();
  return {
    ...actual,
    normalizeDexApiPoolsForMerge: vi.fn(actual.normalizeDexApiPoolsForMerge),
  };
});

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

describe("runDirectApiFetchPhase", () => {
  beforeEach(() => {
    circuitStore.records.clear();
    vi.clearAllMocks();
  });

  it("runs independent direct API fetchers with bounded parallelism", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchers = ["one", "two", "three", "four"].map((name) =>
      makeFetcher(name, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return makeDexApiFetchResult([], { ok: true, degraded: false, errors: [] });
      }),
    );

    const result = await runDirectApiFetchPhase({} as D1Database, fetchers);

    expect(result.results.map((entry) => entry.name)).toEqual(["one", "two", "three", "four"]);
    expect(result.failedSources).toEqual([]);
    expect(result.fallbackSignals).toEqual([]);
    expect(maxActive).toBe(1);
  });

  it("compacts each provider before starting the next while retaining raw counts and exact-key evidence", async () => {
    const rawPoolCount = 6_673;
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
    const fetchers = [
      makeFetcher("first", async () => firstResult),
      makeFetcher("second", async () => {
        expect(firstResult.pools).toHaveLength(1);
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
    expect(normalizeDexApiPoolsForMerge).toHaveBeenCalledTimes(rawPoolCount);
    expect(
      vi.mocked(normalizeDexApiPoolsForMerge).mock.calls.every(([pools]) => pools.length === 1),
    ).toBe(true);
    expect(authoritative.confirmedExactKeysByProtocol.get("first")).toContain(
      "ethereum:0x0000000000000000000000000000000000000101",
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
    expect(getCircuitRecord).not.toHaveBeenCalled();
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
    expect(result.fallbackSignals).toEqual(["unavailable-circuit-unavailable"]);
    expect(result.sourceWarnings).toEqual(["unavailable-circuit: all pages returned 503"]);
  });
});
