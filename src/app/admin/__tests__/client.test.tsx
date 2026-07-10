// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequestAttributionResponse, EndpointProbeResult, StatusCause } from "@shared/types";
import { degraded, makeHealthyHealthResponse, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

const { isOpsUiHostMock, useStatusDashboardModelMock } = vi.hoisted(() => ({
  isOpsUiHostMock: vi.fn(),
  useStatusDashboardModelMock: vi.fn(),
}));

vi.mock("@/lib/admin-access", () => ({
  isOpsUiHost: isOpsUiHostMock,
}));

vi.mock("@/hooks/use-status-dashboard-model", () => ({
  useStatusDashboardModel: useStatusDashboardModelMock,
}));

vi.mock("@/components/feature-page-shell", () => ({
  FeaturePageShell: ({ title, children }: { title: string; children: unknown }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock("@/components/longform-scrollspy-nav", () => ({
  LongformScrollspyNav: () => <div data-testid="scrollspy-nav">scrollspy</div>,
}));

vi.mock("@/components/status/admin-actions-panel", () => ({
  AdminActionsPanel: () => <div data-testid="admin-actions">admin actions</div>,
}));

vi.mock("@/components/status/api-key-load-table", () => ({
  ApiKeyLoadTable: () => <div data-testid="api-key-load-table">api key load</div>,
}));

vi.mock("@/components/status/api-keys-panel", () => ({
  ApiKeysPanel: () => <div data-testid="api-keys-panel">api keys</div>,
}));

vi.mock("@/components/status/cache-freshness-table", () => ({
  CacheFreshnessTable: () => <div data-testid="cache-freshness">cache freshness</div>,
}));

vi.mock("@/components/status/coingecko-price-diff", () => ({
  CoinGeckoPriceDiffCard: () => <div data-testid="coingecko-price-diff">coingecko diff</div>,
}));

vi.mock("@/components/status/circuit-breaker-table", () => ({
  CircuitBreakerTable: () => <div data-testid="circuit-breakers">circuit breakers</div>,
}));

vi.mock("@/components/status/data-quality-cards", () => ({
  DataQualityCards: () => <div data-testid="data-quality-cards">data quality</div>,
}));

vi.mock("@/components/status/dataset-freshness-table", () => ({
  DatasetFreshnessTable: () => <div data-testid="dataset-freshness">dataset freshness</div>,
}));

vi.mock("@/components/status/d1-usage-card", () => ({
  D1UsageCard: () => <div data-testid="d1-usage">d1 usage</div>,
}));

vi.mock("@/components/status/discovery-candidates", () => ({
  DiscoveryCandidatesCard: () => <div data-testid="discovery-candidates">discovery candidates</div>,
}));

vi.mock("@/components/status/endpoint-health-grid", () => ({
  EndpointHealthGrid: () => <div data-testid="endpoint-health">endpoint health</div>,
}));

vi.mock("@/components/status/liquidity-health", () => ({
  LiquidityHealthCard: () => <div data-testid="liquidity-health">liquidity health</div>,
}));

vi.mock("@/components/status/mint-burn-reconciliation", () => ({
  MintBurnReconciliationCard: () => <div data-testid="mint-burn">mint burn</div>,
}));

vi.mock("@/components/status/metadata-integrity-card", () => ({
  MetadataIntegrityCard: () => <div data-testid="metadata-integrity">metadata integrity</div>,
}));

vi.mock("@/components/status/price-source-health", () => ({
  PriceSourceHealthCard: () => <div data-testid="price-source-health">price source</div>,
}));

vi.mock("@/components/status/request-source-attribution-card", () => ({
  RequestSourceAttributionCard: () => <div data-testid="request-source-attribution">request source attribution</div>,
}));

vi.mock("@/components/status/reserve-sync-health", () => ({
  ReserveSyncHealthCard: () => <div data-testid="reserve-sync-health">reserve sync</div>,
}));

vi.mock("@/components/status/recommended-action-strip", () => ({
  RecommendedActionStrip: () => <div data-testid="recommended-actions">recommended actions</div>,
}));

vi.mock("@/components/status/refresh-countdown", () => ({
  RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => (
    <button type="button" onClick={onRefresh}>
      Refresh now
    </button>
  ),
}));

vi.mock("@/components/status/system-diagnostics", () => ({
  SystemDiagnostics: ({ error }: { error?: string | null }) => <div data-testid="system-diagnostics">{error ?? "ok"}</div>,
}));

vi.mock("@/components/status/telegram-bot-stats", () => ({
  TelegramBotStats: () => <div data-testid="telegram-bot-stats">telegram stats</div>,
}));

vi.mock("@/components/status/transition-timeline", () => ({
  TransitionTimeline: () => <div data-testid="transition-timeline">timeline</div>,
}));

const { default: StatusClient } = await import("@/app/admin/client");

const HEALTHY_STATUS = makeHealthyStatusResponse();
const HEALTHY_HEALTH = makeHealthyHealthResponse();

const BASE_STATUS = degraded(HEALTHY_STATUS, {
  availabilityStatus: "degraded",
  rawOverallStatus: "degraded",
  overallStatus: "degraded",
  confidence: 0.92,
  causes: {
    availability: [
      {
        layer: "availability",
        code: "probe-degraded",
        message: "Browser probes are failing.",
        severity: "critical",
      },
    ],
    dataQuality: [],
    overall: [],
  },
  state: {
    ...HEALTHY_STATUS.state,
    currentStatus: "degraded",
    rawStatus: "degraded",
    lastChangedAt: 1_699_999_700,
    consecutiveRaw: {
      healthy: 0,
      degraded: 3,
      stale: 0,
    },
  },
  staleness: {
    ageSeconds: 10,
    maxAgeSec: 60,
    isStale: false,
  },
  probe: {
    timestamp: 1_700_000_000,
    status: "degraded",
    sampleCount: 2,
    passCount: 1,
    failCount: 1,
    p95LatencyMs: 120,
  },
  discrepancy: {
    hasDivergence: false,
    severityDelta: 0,
    statusSeverity: 1,
    probeSeverity: 1,
    details: null,
    probeAgeSeconds: 10,
    consecutiveDivergent: 0,
    discrepancyReason: "in-sync",
  },
  timeline: [],
  caches: {},
  crons: {
    "dispatch-telegram-alerts": {
      healthy: false,
      lastSuccessAt: 1_699_999_940,
      lagSec: 60,
      maxHealthyLagSec: 60,
      failureStreak: 1,
      currentFailureStartedAt: 1_699_999_940,
      warning: "telegram backlog",
      lastRun: {
        startedAt: 1_699_999_940,
        finishedAt: 1_699_999_950,
        durationMs: 10_000,
        status: "degraded",
        error: null,
      },
      inFlight: null,
      telemetryUnknown: false,
    },
  },
  telegramBot: {
    ...(HEALTHY_STATUS.telegramBot ?? {}),
    deliverableChats: 4,
    pendingDeliveries: 2,
    failureBacklog: 0,
    lastDispatchAt: 1_699_999_940,
    oldestPendingAt: 1_699_999_900,
  },
  sectionErrors: {
    statusState: "status persistence degraded",
  },
  datasetFreshness: {
    stablecoins: null,
    blacklist: null,
    mintBurn: null,
    supply: null,
    safetyGrades: null,
    yield: null,
    depegs: null,
    dews: null,
    digest: null,
    discoveryCandidates: null,
  },
  summary: {
    unhealthyCrons: 1,
    availabilityImpactingUnhealthyCrons: 1,
    watchUnhealthyCrons: 0,
    degradedCrons: 1,
    cronErrors: 0,
    availabilityImpactingCronErrors: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
    diagnosticIssueCount: 0,
    worstCacheRatio: 1.2,
  },
});

const BASE_HEALTH = {
  ...HEALTHY_HEALTH,
  status: "degraded" as const,
  mintBurn: {
    ...HEALTHY_HEALTH.mintBurn,
    totalEvents: 0,
    sync: {
      lastSuccessfulSyncAt: null,
      freshnessStatus: "warning",
      warning: "stale",
      criticalLaneHealthy: false,
    },
  },
};

const PROBES: EndpointProbeResult[] = [
  {
    path: "/api/health",
    status: 200,
    latencyMs: 120,
    semanticStatus: "degraded",
    semanticDetail: "Operator probe warning",
    semanticScope: "health",
  },
];

const REQUEST_SOURCE_STATS: ApiRequestAttributionResponse = {
  generatedAt: 1_700_000_000,
  window: {
    from: 1_699_913_600,
    to: 1_700_000_000,
    durationSec: 86_400,
    bucketSizeSec: 3600,
    routeLimit: 5,
    apiKeyLimit: 25,
    retentionDays: 35,
  },
  totals: {
    siteRequests: 600,
    externalRequests: 400,
    totalRequests: 1000,
    siteSharePct: 60,
    externalSharePct: 40,
  },
  siteDelivery: {
    totalSiteRequests: 600,
    pagesCacheHits: 420,
    pagesUpstreamFetches: 150,
    pagesUpstreamTimeouts: 20,
    pagesUpstreamErrors: 10,
    publicApiSiteRequests: 120,
  },
  lanes: [],
  routes: [],
  buckets: [],
  keyedPublicApi: {
    keyedRequests: 220,
    unkeyedRequests: 280,
    totalRequests: 500,
    keyedSharePct: 44,
    unkeyedSharePct: 56,
    totalKeys: 3,
    returnedKeys: 2,
    omittedKeys: 1,
    omittedRequests: 20,
    truncated: true,
  },
  apiKeys: [
    {
      apiKeyId: 7,
      name: "Partner A",
      maskedToken: "ph_live_0123456789abcdef_********",
      trafficClass: "external",
      isActive: true,
      expiresAt: 1_700_100_000,
      rateLimitPerMinute: 180,
      requestCount: 150,
      shareOfKeyedRequestsPct: 68.18,
      shareOfTotalPublicApiRequestsPct: 30,
    },
  ],
  scope: {
    countsTotalSiteDemand: true,
    countsWorkerLoad: true,
    includesPagesProxyCacheHits: true,
  },
};

const TOP_CAUSE: StatusCause = {
  layer: "availability",
  code: "probe-degraded",
  message: "Browser probes are failing.",
  severity: "critical",
};

function makeModel() {
  return {
    allTransitions: [],
    blockerCauses: [TOP_CAUSE],
    browserProbeSummary: {
      sampleCount: 1,
      passCount: 0,
      failCount: 1,
      degradedCount: 1,
      staleCount: 0,
      p95LatencyMs: 120,
      status: "degraded" as const,
      updatedAt: 1_700_000_000,
    },
    clientDataAgeSec: 15,
    clientDataStale: false,
    cronGroups: [
      {
        key: "delivery",
        title: "Delivery",
        badge: "1 job",
        description: "Dispatch and downstream delivery jobs.",
        entries: [["dispatch-telegram-alerts", BASE_STATUS.crons["dispatch-telegram-alerts"]]],
      },
    ],
    latestTransition: null,
    notices: [{ id: "ops-warning", title: "Operator warning", detail: "Investigate probe drift.", tone: "warning" as const }],
    overallCauseCount: 1,
    watchCauseCount: 0,
    overallTone: {
      label: "Degraded",
      badgeClassName: "badge",
      valueClassName: "value",
    },
    querySyncs: [
      { key: "status", label: "Status API", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
      { key: "health", label: "Public health", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
      { key: "probes", label: "Browser probes", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
      { key: "history", label: "Status history", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
      { key: "requestSource", label: "API attribution", updatedAtMs: 1_700_000_000_000, updatedAtSec: 1_700_000_000, ageSec: 0, stale: false },
    ],
    recommendedActions: [],
    runningCrons: 0,
    attentionSections: [
      { id: "reliability", label: "Reliability", kicker: "", title: "Probes, breakers, and cache pressure", description: "", accentClassName: "", value: "Degraded", summary: "Reliability summary" },
      { id: "crons", label: "Crons", kicker: "", title: "Cron Lanes", description: "", accentClassName: "", value: "1 unhealthy", summary: "Cron summary" },
    ],
    sections: [
      { id: "overview", label: "Triage", kicker: "", title: "Triage", description: "", accentClassName: "", value: "Degraded", summary: "State summary" },
      { id: "pipeline", label: "Pipeline", kicker: "", title: "Pipeline Health", description: "", accentClassName: "", value: "Healthy", summary: "Pipeline summary" },
      { id: "reliability", label: "Reliability", kicker: "", title: "Probes, breakers, and cache pressure", description: "", accentClassName: "", value: "Degraded", summary: "Reliability summary" },
      { id: "crons", label: "Crons", kicker: "", title: "Cron Lanes", description: "", accentClassName: "", value: "1 unhealthy", summary: "Cron summary" },
      { id: "actions", label: "Actions", kicker: "", title: "Actions", description: "", accentClassName: "", value: "2 pending", summary: "Actions summary" },
      { id: "credentials", label: "Credentials", kicker: "", title: "Credentials", description: "", accentClassName: "", value: "Managed", summary: "Credentials summary" },
      { id: "comms", label: "Comms", kicker: "", title: "Comms", description: "", accentClassName: "", value: "2 pending", summary: "Comms summary" },
      { id: "history", label: "History", kicker: "", title: "Incident History", description: "", accentClassName: "", value: "24h", summary: "History summary" },
    ],
    statusHoldingAge: 300,
    healthDiffersFromStatus: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  isOpsUiHostMock.mockReset();
  useStatusDashboardModelMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("admin status client", () => {
  it("shows the public-host gate when the ops host is unavailable", async () => {
    isOpsUiHostMock.mockReturnValue(false);

    render(<StatusClient />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Operator tooling is no longer available on the public host.")).toBeTruthy();
    expect(screen.queryByText("Blockers")).toBeNull();
  });

  it("renders the dashboard, auto-expands critical details, and wires refresh/sign-out actions", async () => {
    const handleRefresh = vi.fn();
    const assignSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });

    isOpsUiHostMock.mockReturnValue(true);
    useStatusDashboardModelMock.mockReturnValue({
      data: BASE_STATUS,
      error: null,
      handleRefresh,
      healthData: BASE_HEALTH,
      historyLoading: false,
      historyWindow: "24h",
      isLoading: false,
      lastUpdated: 1_700_000_000_000,
      model: makeModel(),
      probes: PROBES,
      probesLoading: false,
      requestSourceError: null,
      requestSourceLoading: false,
      requestSourceStats: REQUEST_SOURCE_STATS,
      setHistoryWindow: vi.fn(),
    });

    render(<StatusClient />);
    await act(async () => {
      await Promise.resolve();
    });
    // Advance enough to flush initial useEffects (ops-host gate, FreshnessIndicator
    // label compute) without spinning the FreshnessIndicator's 1s interval forever.
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(screen.getAllByText("Impacting").length).toBeGreaterThan(0);
    expect(screen.getByText("Current issues")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Operator warning")).toBeTruthy();
    expect(screen.getByText("API Mix Fetch")).toBeTruthy();
    expect(screen.getByTestId("request-source-attribution")).toBeTruthy();
    expect(screen.getByTestId("api-key-load-table")).toBeTruthy();
    expect(screen.getByTestId("api-keys-panel")).toBeTruthy();
    expect(screen.getByTestId("telegram-bot-stats")).toBeTruthy();

    const diagnosticsDetails = screen
      .getByText("State machine, probe, and discrepancy diagnostics")
      .closest("details");
    const reliabilityDetails = screen
      .getByText("Endpoint probes, circuit breakers, and cache freshness")
      .closest("details");

    expect(diagnosticsDetails?.hasAttribute("open")).toBe(true);
    expect(reliabilityDetails?.hasAttribute("open")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(handleRefresh).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[0]);
    expect(assignSpy).toHaveBeenCalledWith("/cdn-cgi/access/logout");

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("keeps last-good triage visible when a background status refresh fails", async () => {
    const backgroundError = new Error("background refresh failed");
    isOpsUiHostMock.mockReturnValue(true);
    useStatusDashboardModelMock.mockReturnValue({
      data: BASE_STATUS,
      error: backgroundError,
      initialLoadError: null,
      backgroundStatusError: backgroundError,
      hasRetainedStatusData: true,
      handleRefresh: vi.fn(),
      healthData: BASE_HEALTH,
      historyLoading: false,
      historyWindow: "24h",
      isLoading: false,
      lastUpdated: 1_700_000_000_000,
      model: makeModel(),
      probes: PROBES,
      probesLoading: false,
      requestSourceError: null,
      requestSourceLoading: false,
      requestSourceStats: REQUEST_SOURCE_STATS,
      setHistoryWindow: vi.fn(),
    });

    render(<StatusClient />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Current issues")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.queryByText("background refresh failed")).toBeNull();
  });
});
