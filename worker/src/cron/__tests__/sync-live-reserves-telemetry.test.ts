import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext } from "../reserve-adapters/index";
import { getCachedRequest } from "../reserve-adapters/request";
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

function metadataOf(result: { metadata?: string }): { adapterLatency: AdapterLatencySummary } {
  return JSON.parse(result.metadata ?? "{}") as { adapterLatency: AdapterLatencySummary };
}

describe("syncLiveReserves adapter latency telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.resetModules();
    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeSafeMock.mockResolvedValue(undefined);
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
        waveCount: 1,
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

  it("persists attempt, limiter-call, wave, cache-hit, and percentile attribution", async () => {
    let adapterFetches = 0;
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
          adapterFetches += 1;
          const requestKey = `telemetry-request-${adapterFetches}`;
          await getCachedRequest(requestKey, async () => {
            await Promise.all([
              ctx!.ioLimiter!.run("first", async () => undefined),
              ctx!.ioLimiter!.run("second", async () => undefined),
            ]);
            return true;
          }, ctx);
          await getCachedRequest(requestKey, async () => false, ctx);
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
      {},
    );
    const { adapterLatency } = metadataOf(result);
    const configuredCoins = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig).length;
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
      waveCount: adapterFetches,
      errorCount: 0,
    });
    expect(adapterLatency.requestCacheMisses).toBe(adapterFetches);
    expect(adapterLatency.requestCacheHits).toBe(adapterFetches);
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
      waveCount: 3,
      errorCount: 0,
    });
  });

  it("observes preloaded, reordered, rejected, and cleared request-cache promises", async () => {
    const backing = new Map<string, Promise<unknown>>([["preloaded", Promise.resolve(true)]]);
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
            let resolveSuccess!: (value: true) => void;
            const success = new Promise<true>((resolve) => { resolveSuccess = resolve; });
            ctx!.requestCache!.set("success", success);
            ctx!.requestCache!.delete("success");
            ctx!.requestCache!.set("success", success);
            ctx!.requestCache!.delete("success");
            ctx!.requestCache!.set("success", success);
            resolveSuccess(true);
            await success;

            const failure = Promise.reject(new Error("expected request failure"));
            ctx!.requestCache!.set("failure", failure);
            ctx!.requestCache!.delete("failure");
            ctx!.requestCache!.set("failure", failure);
            await failure.catch(() => undefined);
            ctx!.requestCache!.clear();
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
      { requestCache: backing },
    );
    const { adapterLatency } = metadataOf(result);

    expect(backing.size).toBe(0);
    expect(adapterLatency.requestCacheMisses).toBe(2);
    expect(adapterLatency.requestCacheHits).toBe(2);
  });

  it("persists a valid zero-attempt summary when the whole queue is deferred", async () => {
    getReserveAdapterMock.mockImplementation(() => {
      throw new Error("adapter must not be loaded");
    });
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const result = await syncLiveReserves(
      mockLiveReserveD1(),
      new AbortController().signal,
      {},
      undefined,
      { runBudgetMs: 1, adapterTimeoutMs: 20_000 },
    );
    const { adapterLatency } = metadataOf(result);

    expect(adapterLatency).toMatchObject({
      schemaVersion: 1,
      groups: [],
      total: {
        attemptCount: 0,
        ioCallCount: 0,
        waveCount: 0,
        errorCount: 0,
        elapsedMs: {
          count: 0,
          sumMs: 0,
          p50UpperBoundMs: null,
          p95UpperBoundMs: null,
        },
      },
      requestCacheHits: 0,
      requestCacheMisses: 0,
      omittedGroups: 0,
      omittedAttempts: 0,
      overflow: false,
    });
  });
});
