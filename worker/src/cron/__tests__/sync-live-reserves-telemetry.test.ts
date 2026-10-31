import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import type * as StablecoinRegistry from "@shared/lib/stablecoins/worker-runtime-registry";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { ResourcePressureSchema, type ResourcePressure } from "@shared/types/status/cron";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { AdapterContext } from "../reserve-adapters/index";
import { observeMockD1Cost } from "../../lib/__tests__/d1-cost.test-support";
import {
  createRequestBodyObserver,
  getCachedRequest,
  REQUEST_CACHE_MAX_ENTRY_BYTES,
  REQUEST_CACHE_MAX_TOTAL_BYTES,
} from "../reserve-adapters/request";
import { MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES } from "../../lib/cron-metadata-persistence";
import {
  ADAPTER_LATENCY_MAX_BYTES,
  ADAPTER_LATENCY_MAX_GROUPS,
  createAdapterLatencyCollector,
  type AdapterLatencySummary,
} from "../sync-live-reserves-core";
import {
  getReserveAdapterMock,
  mockLiveReserveD1,
  recordOutcomeSafeMock,
  shouldAttemptFetchMock,
} from "./live-reserves.test-support";
import { syncLiveReserves } from "../sync-live-reserves";

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", async (importOriginal) => {
  const registry = await importOriginal<typeof StablecoinRegistry>();
  return {
    ...registry,
    WORKER_ACTIVE_STABLECOINS: registry.WORKER_ACTIVE_STABLECOINS.filter((coin) =>
      ["usdc-circle", "eurc-circle"].includes(coin.id)),
  };
});

function metadataOf(result: { metadata?: string }): {
  adapterLatency: AdapterLatencySummary;
  resourcePressure: ResourcePressure;
} {
  return JSON.parse(result.metadata ?? "{}");
}

describe("syncLiveReserves adapter latency telemetry", () => {
  it("preserves setup D1 exceptions without synthesizing a successful result", async () => {
    const failure = new Error("original reserve setup failure");
    const db = mockLiveReserveD1([{ match: "FROM reserve_sync_state", rows: [], throwError: failure }]);
    await expect(syncLiveReserves(db, new AbortController().signal)).rejects.toBe(failure);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeSafeMock.mockResolvedValue(undefined);
  });

  it("includes adapter-context D1 calls without changing their SQL rows", async () => {
    const rows = [{ id: "adapter-evidence" }];
    const db = mockLiveReserveD1([{ match: "SELECT adapter_evidence", rows }]);
    const assertCost = observeMockD1Cost(db);
    let adapterReads = 0;
    getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => ({
      ...LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey],
      key: adapterKey,
      fetch: async (_coin: unknown, _config: unknown, _signal: AbortSignal, ctx?: AdapterContext) => {
        expect((await ctx!.db!.prepare("SELECT adapter_evidence").all()).results).toBe(rows);
        adapterReads++;
        return {
          slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
          metadata: { freshnessMode: "not-applicable" as const },
        };
      },
    }));
    const result = await syncLiveReserves(db, new AbortController().signal, { db });
    expect(adapterReads).toBeGreaterThan(0);
    expect(assertCost(result).bindingCalls).toBeGreaterThanOrEqual(adapterReads);
    expect(JSON.parse(result.metadata!)).toMatchObject({ failed: 0 });
  });

  it("does not strongly retain evicted or oversized payload promises and keeps LRU hit accounting", async () => {
    function stronglyOwns(root: unknown, target: unknown, seen = new Set<unknown>()): boolean {
      if (root === target) return true;
      if (!root || typeof root !== "object" || seen.has(root) || root instanceof WeakMap || root instanceof WeakSet) return false;
      seen.add(root);
      const children = root instanceof Map ? [...root.keys(), ...root.values()] : [];
      children.push(...Object.values(Object.getOwnPropertyDescriptors(root)).flatMap((descriptor) => "value" in descriptor ? [descriptor.value] : []));
      return children.some((child) => stronglyOwns(child, target, seen));
    }
    let exercised = false;
    getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => ({
      ...LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey], key: adapterKey,
      fetch: async (_coin: unknown, _config: unknown, _signal: AbortSignal, ctx?: AdapterContext) => {
        if (!exercised) {
          exercised = true;
          const requests = [];
          for (let index = 0; index < 20; index++) {
            const promise = getCachedRequest(`payload-${index}`, async () => ({
              value: new Uint8Array(1024 * 1024), cacheBytes: 1024 * 1024, basis: "declared-estimate",
            }), ctx);
            requests.push(promise);
            await promise;
          }
          const oversized = getCachedRequest("oversized", async () => ({
            value: new Uint8Array(5 * 1024 * 1024), cacheBytes: 5 * 1024 * 1024, basis: "declared-estimate",
          }), ctx);
          await oversized;
          expect(ctx!.requestCache!.size).toBe(16);
          expect(ctx!.requestCache!.has("oversized")).toBe(false);
          for (const promise of [...requests.slice(0, 4), oversized]) expect(stronglyOwns(ctx!.requestCache, promise)).toBe(false);
          await getCachedRequest("payload-19", async () => { throw new Error("cached request must not refetch"); }, ctx);
          await getCachedRequest("replacement", async () => ({
            value: true, cacheBytes: 128, basis: "declared-estimate",
          }), ctx);
        }
        return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }], metadata: { freshnessMode: "not-applicable" as const } };
      },
    }));
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const result = await syncLiveReserves(mockLiveReserveD1(), new AbortController().signal, {});
    expect(exercised).toBe(true);
    expect(metadataOf(result).adapterLatency.requestCacheHits).toBe(1);
    expect(metadataOf(result).adapterLatency.requestCacheMisses).toBe(22);
  });

  it("emits bounded, deterministically ordered histograms", () => {
    const collector = createAdapterLatencyCollector();
    for (let index = ADAPTER_LATENCY_MAX_GROUPS + 40; index >= 0; index--) {
      collector.recordAttempt({
        adapterKey: `adapter-${String(index).padStart(3, "0")}`,
        chain: "ethereum",
        stage: index % 2 === 0 ? "primary" : "fallback",
        cacheHit: index % 3 === 0,
        ioCallCount: 2,
        ioActivityBurstCount: 1,
        elapsedMs: index + 1,
        error: index % 5 === 0,
      });
    }

    const summary = collector.finalize();
    const serializedBytes = new TextEncoder().encode(JSON.stringify(summary)).length;

    expect(summary.total.attemptCount).toBe(ADAPTER_LATENCY_MAX_GROUPS + 41);
    expect(summary.groups.length).toBeLessThanOrEqual(ADAPTER_LATENCY_MAX_GROUPS);
    expect(serializedBytes).toBeLessThanOrEqual(ADAPTER_LATENCY_MAX_BYTES);
    expect(summary.overflow).toBe(true);
    expect(summary.omittedGroups).toBeGreaterThan(0);
    expect(summary.omittedAttempts).toBe(summary.total.attemptCount - summary.groups.length);
    expect(summary.groups.map((group) => group.adapterKey)).toEqual(
      [...summary.groups.map((group) => group.adapterKey)].sort(),
    );
  });

  it("normalizes invalid durations and leaves overflow percentiles unbounded", () => {
    const collector = createAdapterLatencyCollector();
    for (const elapsedMs of [-1, NaN, Infinity, 20_001]) {
      collector.recordAttempt({
        adapterKey: "test", chain: "ethereum", stage: "primary", cacheHit: false,
        ioCallCount: 0, ioActivityBurstCount: 0, elapsedMs, error: false,
      });
    }
    expect(collector.finalize().total.elapsedMs).toEqual({
      count: 4, sumMs: 20_001,
      buckets: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
      p50UpperBoundMs: 1, p95UpperBoundMs: null,
    });
  });

  it("persists attempt, limiter-call, wave, cache-hit, and percentile attribution", async () => {
    let adapterFetches = 0;
    let setupReported = false;
    const onRequestCache = vi.fn();
    const progress: Parameters<CronProgressReporter>[0][] = [];
    const reportProgress: CronProgressReporter = async (update) => {
      progress.push(update);
      if (update.stage === "setup") {
        await Promise.resolve();
        setupReported = true;
      }
    };
    getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => {
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey];
      return {
        key: adapterKey,
        sourceModel: definition.sourceModel,
        evidenceClass: definition.evidenceClass,
        sharedSourceMode: definition.sharedSourceMode,
        validation: "validation" in definition ? definition.validation : undefined,
        fetch: async (
          _coin: unknown,
          _config: unknown,
          _signal: AbortSignal,
          ctx?: AdapterContext,
        ) => {
          expect(setupReported).toBe(true);
          adapterFetches += 1;
          const requestKey = `telemetry-request-${adapterFetches}`;
          await getCachedRequest(requestKey, async () => {
            createRequestBodyObserver(ctx, 1024).onBodyRead({
              intakeBytes: 64, declaredBytes: 64, limitBytes: 1024, outcome: "accepted",
            });
            await Promise.all([
              ctx!.ioLimiter!.run("first", async () => undefined),
              ctx!.ioLimiter!.run("second", async () => undefined),
            ]);
            return { value: true, cacheBytes: 128, basis: "declared-estimate" };
          }, ctx);
          await getCachedRequest(requestKey, async () => ({
            value: false, cacheBytes: 128, basis: "declared-estimate",
          }), ctx);
          return {
            slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
            metadata: { freshnessMode: "not-applicable" as const },
          };
        },
      };
    });

    const db = mockLiveReserveD1();
    const assertCost = observeMockD1Cost(db);
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      { onRequestCache },
      reportProgress,
    );
    const { adapterLatency, resourcePressure } = metadataOf(result);
    expect(assertCost(result).bindingCalls).toBeGreaterThan(0);
    const configuredCoins = WORKER_ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig).length;
    const cacheHitAttempts = adapterLatency.groups
      .filter((group) => group.cacheHit)
      .reduce((sum, group) => sum + group.attemptCount, 0);

    expect(adapterLatency.schemaVersion).toBe(1);
    expect(adapterLatency.overflow).toBe(false);
    expect(new TextEncoder().encode(result.metadata ?? "").length)
      .toBeLessThanOrEqual(MAX_CRON_METADATA_BEFORE_SCHEDULER_ENRICHMENT_BYTES);
    expect(adapterLatency.total).toMatchObject({
      attemptCount: configuredCoins,
      ioCallCount: adapterFetches * 2,
      ioActivityBurstCount: adapterFetches,
      errorCount: 0,
    });
    expect(adapterLatency.requestCacheMisses).toBe(adapterFetches);
    expect(adapterLatency.requestCacheHits).toBe(adapterFetches);
    expect(onRequestCache).toHaveBeenCalledTimes(adapterFetches * 2);
    expect(onRequestCache.mock.calls.filter(([event]) => event.hit)).toHaveLength(adapterFetches);
    expect(onRequestCache.mock.calls.filter(([event]) => !event.hit)).toHaveLength(adapterFetches);
    expect(progress.map((update) => update.stage)).toEqual(expect.arrayContaining(["setup", "syncing", "finalizing"]));
    for (const update of progress) {
      const pressure = ResourcePressureSchema.parse(update.metadata?.resourcePressure);
      expect(pressure.phase).toBe(update.stage);
      expect(update.metadata).toHaveProperty("adapterTelemetryProgress");
      expect(update.metadata).toHaveProperty("synced");
    }
    expect(progress[0].metadata?.resourcePressure).toMatchObject({
      phase: "setup",
      intakeBytes: null,
      cacheBytes: 0,
    });
    expect(ResourcePressureSchema.parse(resourcePressure)).toMatchObject({
      phase: "terminal",
      bodyCapBytes: 1024,
      cacheCapBytes: REQUEST_CACHE_MAX_TOTAL_BYTES,
      cacheEntryCapBytes: REQUEST_CACHE_MAX_ENTRY_BYTES,
      intakeBytes: adapterFetches * 64,
      cacheBytes: adapterFetches * 128,
      rejectedBodies: 0,
      cacheBasis: "declared-estimate",
      heapUsedBytes: null,
    });
    expect(cacheHitAttempts).toBe(configuredCoins - adapterFetches);
    expect(adapterLatency.groups.every((group) => (
      group.elapsedMs.count === group.attemptCount
      && group.elapsedMs.p50UpperBoundMs != null
      && group.elapsedMs.p95UpperBoundMs != null
    ))).toBe(true);
  });

  it("releases limiter capacity after resolved, rejected, and synchronously thrown I/O", async () => {
    let exercised = false;
    const observedErrors: string[] = [];
    getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => {
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey];
      return {
        key: adapterKey,
        sourceModel: definition.sourceModel,
        evidenceClass: definition.evidenceClass,
        sharedSourceMode: definition.sharedSourceMode,
        validation: "validation" in definition ? definition.validation : undefined,
        fetch: async (
          _coin: unknown,
          _config: unknown,
          _signal: AbortSignal,
          ctx?: AdapterContext,
        ) => {
          if (!exercised) {
            exercised = true;
            await ctx!.ioLimiter!.run("resolved", async () => undefined);
            for (const [label, factory] of [
              ["rejected", async () => { throw new Error("async I/O failed"); }],
              ["thrown", () => { throw new Error("sync I/O failed"); }],
            ] as const) {
              try {
                await ctx!.ioLimiter!.run(label, factory);
              } catch (error) {
                observedErrors.push((error as Error).message);
              }
            }
          }
          return {
            slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
            metadata: { freshnessMode: "not-applicable" as const },
          };
        },
      };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const result = await syncLiveReserves(mockLiveReserveD1(), new AbortController().signal, {});

    expect(observedErrors).toEqual(["async I/O failed", "sync I/O failed"]);
    expect(metadataOf(result).adapterLatency.total).toMatchObject({
      ioCallCount: 3,
      ioActivityBurstCount: 3,
      errorCount: 0,
    });
  });

  it("observes helper cache hits, pending deduplication, rejection retries, and external observers", async () => {
    const backing = new Map<string, Promise<unknown>>([["preloaded", Promise.resolve(true)]]);
    const onRequestCache = vi.fn();
    let exerciseCache = true;
    getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => {
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey];
      return {
        key: adapterKey,
        sourceModel: definition.sourceModel,
        evidenceClass: definition.evidenceClass,
        sharedSourceMode: definition.sharedSourceMode,
        validation: "validation" in definition ? definition.validation : undefined,
        fetch: async (
          _coin: unknown,
          _config: unknown,
          _signal: AbortSignal,
          ctx?: AdapterContext,
        ) => {
          if (exerciseCache) {
            exerciseCache = false;
            expect(ctx!.requestCache).toBe(backing);
            await getCachedRequest("preloaded", async () => { throw new Error("preloaded request must not refetch"); }, ctx);
            let resolveSuccess!: (value: true) => void;
            const success = new Promise<true>((resolve) => { resolveSuccess = resolve; });
            const pending = getCachedRequest("success", async () => ({
              value: await success, cacheBytes: 128, basis: "declared-estimate",
            }), ctx);
            const duplicate = getCachedRequest("success", async () => { throw new Error("pending request must not refetch"); }, ctx);
            expect(duplicate).toBe(pending);
            resolveSuccess(true);
            await pending;
            await getCachedRequest("success", async () => { throw new Error("retained request must not refetch"); }, ctx);

            await expect(getCachedRequest("failure", async () => { throw new Error("expected request failure"); }, ctx))
              .rejects.toThrow("expected request failure");
            await getCachedRequest("failure", async () => ({
              value: true, cacheBytes: 128, basis: "declared-estimate",
            }), ctx);
            backing.clear();
          }
          return {
            slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
            metadata: { freshnessMode: "not-applicable" as const },
          };
        },
      };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const result = await syncLiveReserves(
      mockLiveReserveD1(),
      new AbortController().signal,
      { requestCache: backing, onRequestCache },
    );
    const { adapterLatency } = metadataOf(result);

    expect(backing.size).toBe(0);
    expect(adapterLatency.requestCacheMisses).toBe(3);
    expect(adapterLatency.requestCacheHits).toBe(3);
    expect(onRequestCache.mock.calls.map(([event]) => ({ key: event.key, hit: event.hit }))).toEqual([
      { key: "preloaded", hit: true },
      { key: "success", hit: false },
      { key: "success", hit: true },
      { key: "success", hit: true },
      { key: "failure", hit: false },
      { key: "failure", hit: false },
    ]);
    expect(metadataOf(result).resourcePressure).toMatchObject({
      phase: "terminal", cacheBytes: 0,
    });
  });
});
