import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDexApiFetchResult } from "../../../lib/dex-api-common";
import { getCircuitRecord } from "../../../lib/circuit-breaker";
import type { DirectApiFetcher } from "../orchestrator-phases/direct-api";
import { runDirectApiFetchPhase } from "../orchestrator-phases/direct-api";

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
    expect(maxActive).toBe(2);
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
    expect(result.results[0]?.result.warnings).toEqual(["retained pool enrichment failed"]);
  });
});
