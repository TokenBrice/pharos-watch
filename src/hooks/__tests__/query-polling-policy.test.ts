import { beforeEach, describe, expect, it, vi } from "vitest";

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("@shared/lib/api-endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/api-endpoints")>();
  return {
    ...actual,
    getProbePaths: (group: "public" | "admin" | "manual") => {
      if (group === "public") return ["/api/health"];
      if (group === "admin") return ["/api/status"];
      return ["/api/sync-stablecoins"];
    },
  };
});

import { createPollingQueryOptions, createStaticQueryOptions } from "../use-api-query";
import { CRON_1MIN, CRON_30MIN, CRON_TELEGRAM_PULSE } from "@/lib/cron-intervals";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { useHealth } from "../api-hooks";
import { useRequestSourceStats } from "../use-request-source-stats";
import { useStatus } from "../use-status";
import { useEndpointProbes } from "../use-endpoint-probes";
import { useStabilityIndexLight } from "../use-stability-index-light";
import { useTelegramPulse } from "../use-telegram-pulse";

function mockQueryReturn() {
  useQueryMock.mockReturnValue({
    data: undefined,
    error: null,
    isLoading: false,
    isFetching: false,
    dataUpdatedAt: 0,
  });
}

function queryContext(queryKey: readonly unknown[]) {
  return {
    signal: new AbortController().signal,
    queryKey,
    meta: undefined,
  } as never;
}

function minimalStatusResponse() {
  return {
    timestamp: 1,
    dbHealthy: true,
    availabilityStatus: "healthy",
    dataQualityStatus: "healthy",
    rawOverallStatus: "healthy",
    overallStatus: "healthy",
    confidence: 1,
    causes: { availability: [], dataQuality: [], overall: [] },
    state: {
      scope: "global",
      currentStatus: "healthy",
      rawStatus: "healthy",
      lastEvaluatedAt: 1,
      lastChangedAt: 1,
      minDwellSec: 300,
      staleMinDwellSec: 900,
      consecutiveRaw: { healthy: 1, degraded: 0, stale: 0 },
      thresholds: {
        escalateToDegraded: 2,
        escalateToStale: 3,
        recoverToDegraded: 2,
        recoverToHealthy: 3,
      },
    },
    staleness: { ageSeconds: 0, maxAgeSec: 60, isStale: false },
    probe: { timestamp: 1, status: "healthy", sampleCount: 1, passCount: 1, failCount: 0, p95LatencyMs: 10 },
    discrepancy: {
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 0,
      probeSeverity: 0,
      details: null,
      probeAgeSeconds: 0,
      consecutiveDivergent: 0,
      discrepancyReason: "in-sync",
    },
    timeline: [],
    caches: {},
    crons: {},
    dataQuality: {},
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: {},
    summary: {},
    liquidityHealth: null,
    yieldHealth: null,
    publicationHealth: null,
    dependencyHealth: null,
    providerCircuitHealth: null,
    canaries: null,
    priceSourceHealth: null,
    priceProviderDiagnostics: null,
    gtProbe: null,
    coingeckoPriceDiff: null,
    d1Usage: null,
    budgetOnlySurfaces: [],
    mintBurnReconciliation: null,
    reserveComposition: {
      configuredCoins: 0,
      freshCoins: 0,
      staleCoins: 0,
      missingCoins: 0,
      degradedCoins: 0,
      errorCoins: 0,
      corruptCoins: 0,
      independentFreshEligible: 0,
      independentFreshUnverified: 0,
      staticValidatedFresh: 0,
      weakProbeFresh: 0,
      writeTimeoutUncertain: 0,
      deferredCoins: 0,
      runBudgetTruncated: false,
      deferredAt: null,
      nextCursorStablecoinId: null,
      cursorTailState: null,
      cursorTailError: null,
      cursorRecordedAt: null,
      cursorTailCompletedAt: null,
      cursorTailFailedAt: null,
      runBudgetTruncationCount: 0,
      historyWriteGaps: [],
      persistentlyStaleIndependentCoins: [],
      lastSuccessAt: null,
      oldestFreshAgeSec: null,
      status: "healthy",
      freshCoverageRatio: 0,
      authoritativeFreshCoverageRatio: 0,
    },
  };
}

function minimalRequestSourceStatsResponse() {
  return {
    generatedAt: 1,
    window: {
      from: 1,
      to: 2,
      durationSec: 1,
      bucketSizeSec: 3600,
      routeLimit: 5,
      apiKeyLimit: 25,
      retentionDays: 30,
    },
    totals: { siteRequests: 0, externalRequests: 0, totalRequests: 0, siteSharePct: 0, externalSharePct: 0 },
    siteDelivery: {
      totalSiteRequests: 0,
      pagesCacheHits: 0,
      pagesUpstreamFetches: 0,
      pagesUpstreamTimeouts: 0,
      pagesUpstreamErrors: 0,
      publicApiSiteRequests: 0,
    },
    lanes: [],
    routes: [],
    buckets: [],
    keyedPublicApi: {
      keyedRequests: 0,
      unkeyedRequests: 0,
      totalRequests: 0,
      keyedSharePct: 0,
      unkeyedSharePct: 0,
      totalKeys: 0,
      returnedKeys: 0,
      omittedKeys: 0,
      omittedRequests: 0,
      truncated: false,
    },
    apiKeys: [],
    scope: {
      countsTotalSiteDemand: true,
      countsWorkerLoad: true,
      includesPagesProxyCacheHits: true,
    },
  };
}

describe("query polling policy", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    mockQueryReturn();
    vi.restoreAllMocks();
  });

  it("createPollingQueryOptions enforces stale=interval and refetch=2x interval", () => {
    const options = createPollingQueryOptions(["k"], async () => 1, 15_000);
    expect(options.staleTime).toBe(15_000);
    expect(options.refetchInterval).toBe(30_000);
    expect(options.retry).toBe(2);
  });

  it("createStaticQueryOptions disables polling explicitly", () => {
    const options = createStaticQueryOptions(["static"], async () => 1);
    expect(options.staleTime).toBe(Infinity);
    expect(options.refetchInterval).toBe(false);
    expect(options.retry).toBe(1);
  });

  it("useHealth uses shared polling policy with endpoint-specific retry", () => {
    useHealth();
    const options = useQueryMock.mock.calls[0][0] as {
      staleTime: number;
      refetchInterval: number;
      retry: number;
    };

    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
    expect(options.retry).toBe(1);
  });

  it("useStabilityIndexLight reuses registered meta polling", () => {
    useStabilityIndexLight();
    const options = useQueryMock.mock.calls[0][0] as {
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
      retry: number;
    };

    expect(options.queryKey).toEqual(FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndex.queryKey);
    expect(options.staleTime).toBe(CRON_30MIN);
    expect(options.refetchInterval).toBe(2 * CRON_30MIN);
    expect(options.retry).toBe(2);
  });

  it("useTelegramPulse derives polling from the telegram pulse snapshot cron", () => {
    useTelegramPulse();
    const options = useQueryMock.mock.calls[0][0] as {
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
    };

    expect(options.queryKey).toEqual(["telegram-pulse"]);
    expect(options.staleTime).toBe(CRON_TELEGRAM_PULSE);
    expect(options.refetchInterval).toBe(2 * CRON_TELEGRAM_PULSE);
  });

  it("useStatus uses the ops proxy with no browser admin key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => minimalStatusResponse(),
    } as Response);

    useStatus();
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      retry: number;
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
      queryFn: () => Promise<unknown>;
    };

    expect(options.enabled).toBeUndefined();
    expect(options.retry).toBe(0);
    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
    expect(options.queryKey).toEqual(["status", "ops-proxy"]);

    await options.queryFn();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/admin/status");
    expect(init).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("lets route workspaces disable status polling without changing the shared policy", () => {
    useStatus({ enabled: false });
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      staleTime: number;
      refetchInterval: number;
    };

    expect(options.enabled).toBe(false);
    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
  });

  it("useRequestSourceStats uses the ops proxy and shared polling policy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => minimalRequestSourceStatsResponse(),
    } as Response);

    useRequestSourceStats();
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      retry: number;
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
      queryFn: () => Promise<unknown>;
    };

    expect(options.enabled).toBeUndefined();
    expect(options.retry).toBe(0);
    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
    expect(options.queryKey).toEqual(["request-source-stats", 24, 3600, 5, 25, "ops-proxy"]);

    await options.queryFn();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/admin/request-source-stats?hours=24&bucketSec=3600&routeLimit=5&apiKeyLimit=25");
    expect(init).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("useEndpointProbes uses shared polling and switches admin paths to same-origin proxy mode", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    useEndpointProbes();
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      retry: number;
      staleTime: number;
      refetchInterval: number;
      queryKey: unknown[];
      queryFn: (context: ReturnType<typeof queryContext>) => Promise<unknown[]>;
    };

    expect(options.enabled).toBe(true);
    expect(options.retry).toBe(0);
    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
    expect(options.queryKey).toEqual(["endpoint-probes", "ops-proxy"]);

    await options.queryFn(queryContext(options.queryKey));

    const [publicCall, adminCall] = fetchMock.mock.calls;
    expect(publicCall[0]).toEqual(expect.stringContaining("/api/health"));
    expect((publicCall[1] as RequestInit).headers).toBeUndefined();
    expect(adminCall[0]).toBe("/api/admin/status");
    expect((adminCall[1] as RequestInit).headers).toBeUndefined();
  });

  it("gives critical operator probes a distinct cache key and supports disabling them", () => {
    useEndpointProbes({ mode: "critical", enabled: false });
    const options = useQueryMock.mock.calls[0][0] as {
      enabled: boolean;
      queryKey: unknown[];
      staleTime: number;
      refetchInterval: number;
    };

    expect(options.enabled).toBe(false);
    expect(options.queryKey).toEqual(["endpoint-probes", "ops-proxy", "critical"]);
    expect(options.staleTime).toBe(CRON_1MIN);
    expect(options.refetchInterval).toBe(2 * CRON_1MIN);
  });

  it("gives admin probes a longer timeout budget than public probes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
          });
        }),
    );

    useEndpointProbes();
    const options = useQueryMock.mock.calls[0][0] as {
      queryFn: (context: ReturnType<typeof queryContext>) => Promise<Array<{ error?: string; status: number | null }>>;
      queryKey: readonly unknown[];
    };

    const resultPromise = options.queryFn(queryContext(options.queryKey));
    const publicSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    const adminSignal = (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.signal;

    expect(publicSignal?.aborted).toBe(false);
    expect(adminSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(publicSignal?.aborted).toBe(true);
    expect(adminSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(adminSignal?.aborted).toBe(true);

    const result = await resultPromise;
    expect(result).toEqual([
      expect.objectContaining({
        status: null,
        error: "Browser probe timed out",
      }),
      expect.objectContaining({
        status: null,
        error: "Browser probe timed out",
      }),
    ]);
  });
});
