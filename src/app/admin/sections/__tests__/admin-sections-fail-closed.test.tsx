// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  degraded,
  makeApiRequestAttributionResponse,
  makeHealthyHealthResponse,
  makeHealthyReliabilityStatusResponse,
  makeHealthyStatusResponse,
} from "@/test-utils/status-fixtures";

vi.mock("@/components/status/admin-actions-panel", () => ({
  AdminActionsPanel: () => null,
}));
vi.mock("@/components/status/pipeline-quality-table", () => ({
  PipelineQualityTable: () => <div>Quality panel mounted</div>,
}));
vi.mock("@/components/status/price-source-health", () => ({
  PriceSourceHealthCard: () => <div>Price source panel mounted</div>,
}));
vi.mock("@/components/status/liquidity-health", () => ({
  LiquidityHealthCard: () => <div>Liquidity panel mounted</div>,
}));
vi.mock("@/components/status/coingecko-price-diff", () => ({
  CoinGeckoPriceDiffCard: () => <div>CoinGecko panel mounted</div>,
}));
vi.mock("@/components/status/score-impact-panel", () => ({
  ScoreImpactPanel: () => <div>Reserve score panel mounted</div>,
}));
vi.mock("@/components/status/reserve-sync-health", () => ({
  ReserveSyncHealthCard: () => <div>Reserve sync panel mounted</div>,
}));
vi.mock("@/components/status/mint-burn-reconciliation", () => ({
  MintBurnReconciliationCard: () => <div>Mint burn panel mounted</div>,
}));
vi.mock("@/components/status/metadata-integrity-card", () => ({
  MetadataIntegrityCard: () => <div>Metadata panel mounted</div>,
}));
vi.mock("@/components/status/yield-health", () => ({
  YieldHealthCard: () => <div>Yield panel mounted</div>,
}));
vi.mock("@/components/status/dataset-freshness-table", () => ({
  DatasetFreshnessTable: () => <div>Freshness panel mounted</div>,
}));
vi.mock("@/components/status/d1-usage-card", () => ({
  D1UsageCard: () => <div>D1 panel mounted</div>,
}));
vi.mock("@/components/status/pipeline-integrity-panel", () => ({
  PipelineIntegrityPanel: () => <div>Integrity panel mounted</div>,
}));
vi.mock("@/components/status/reliability-impact-panel", () => ({
  ReliabilityImpactPanel: () => <div>Impact panel mounted</div>,
}));
vi.mock("@/components/status/reliability-endpoints-panel", () => ({
  ReliabilityEndpointsPanel: () => <div>Endpoints panel mounted</div>,
}));
vi.mock("@/components/status/reliability-dependencies-panel", () => ({
  ReliabilityDependenciesPanel: () => <div>Dependencies panel mounted</div>,
}));
vi.mock("@/components/status/request-source-attribution-card", () => ({
  RequestSourceAttributionCard: () => <div>Demand attribution mounted</div>,
}));
vi.mock("@/components/status/api-key-load-table", () => ({
  ApiKeyLoadTable: () => <div>API load mounted</div>,
}));
vi.mock("@/components/status/cache-freshness-table", () => ({
  CacheFreshnessTable: () => <div>Cache panel mounted</div>,
}));

import { ActionsSection } from "../actions-section";
import { CommsSection } from "../comms-section";
import { PipelineSection } from "../pipeline-section";
import { ReliabilitySection } from "../reliability-section";

describe("ActionsSection cron evidence", () => {
  afterEach(cleanup);

  it.each([null, 0])("renders unavailable separately from observed zero (%s)", (count) => {
    const data = makeHealthyStatusResponse();
    data.summary.cronErrors = count;
    data.summary.availabilityImpactingUnhealthyCrons = count;
    data.summary.cronHistoryUnavailableReason = count == null ? "cron-history-read-failed" : null;
    render(<ActionsSection data={data} healthData={makeHealthyHealthResponse()} clientDataStale={false}
      handleRefresh={vi.fn()} recommendedActions={[]} />);
    for (const label of ["Cron errors", "Impacting crons"]) {
      const badge = screen.getByText(label).parentElement!;
      expect(within(badge).getByText(count == null ? "Unavailable" : "0")).toBeTruthy();
      expect(within(badge).queryByText(count == null ? "0" : "Unavailable")).toBeNull();
    }
  });
});

describe("CommsSection", () => {
  it("does not manufacture healthy Comms state when section and dispatch telemetry are unavailable", () => {
    const data = makeHealthyStatusResponse();
    data.telegramBot = null;
    delete data.crons["dispatch-telegram-alerts"];
    data.sectionErrors.telegramBot = { code: "telegram_query_failed", message: "Telegram query unavailable" };

    render(<CommsSection data={data} />);

    expect(screen.getByText("Delivery").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Oldest backlog").nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getAllByText("Permanent failures")[0].nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getAllByText("Latest dispatch")[0].nextElementSibling?.textContent).toBe("Unknown");
    expect(screen.getByText("Telegram query unavailable")).toBeTruthy();
  });
});

describe("PipelineSection", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/admin/pipeline/?view=quality");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("surfaces loader failures for inactive modes with human and raw labels", () => {
    const base = makeHealthyStatusResponse();
    const data = degraded(base, {
      sectionErrors: {
        reserveDrift: {
          code: "reserve_drift_computation_failed",
          message: "Reserve drift loader timed out",
        },
      },
    });

    render(<PipelineSection data={data} />);

    expect(screen.getByText("Loader coverage is incomplete")).toBeTruthy();
    expect(screen.getByText("Reserve drift")).toBeTruthy();
    expect(screen.getByText(/reserveDrift · reserve_drift_computation_failed/)).toBeTruthy();
    expect(screen.getByText("Quality panel mounted")).toBeTruthy();
    expect(screen.queryByText("Metadata panel mounted")).toBeNull();
  });
});

describe("ReliabilitySection", () => {
  const REQUEST_STATS = makeApiRequestAttributionResponse({
    window: { from: 1, to: 2, durationSec: 1, bucketSizeSec: 1, routeLimit: 1, apiKeyLimit: 1, retentionDays: 1 },
  });

  function completeData() {
    return degraded(makeHealthyReliabilityStatusResponse(), {
      caches: { fixture: { ageSeconds: 30, maxAge: 60, healthy: true } },
    });
  }

  function props() {
    const data = completeData();
    return {
      data,
      healthData: makeHealthyHealthResponse(),
      healthError: null,
      healthLoading: false,
      requestSourceStats: REQUEST_STATS,
      requestSourceError: null,
      requestSourceLoading: false,
      browserProbeSummary: {
        sampleCount: 1,
        passCount: 1,
        failCount: 0,
        degradedCount: 0,
        staleCount: 0,
        p95LatencyMs: 20,
        status: "healthy" as const,
        updatedAt: data.timestamp,
      },
      probes: [{ path: "/api/health", status: 200, latencyMs: 20, semanticStatus: "healthy" as const }],
      probesError: null,
      probesLoading: false,
    };
  }

  beforeEach(() => {
    window.history.replaceState({}, "", "/admin/reliability/?view=impact");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("surfaces an inactive dependency loader failure in the workspace summary", () => {
    const baseProps = props();
    const data = degraded(baseProps.data, {
      dependencyHealth: null,
      sectionErrors: {
        dependencyHealth: { code: "dependency_query_failed", message: "Dependency inventory timed out" },
      },
    });

    render(<ReliabilitySection {...baseProps} data={data} />);

    expect(screen.getByText("Reliability evidence is incomplete")).toBeTruthy();
    expect(screen.getByText("Dependency health")).toBeTruthy();
    expect(screen.getByText(/dependencyHealth · dependency_query_failed/)).toBeTruthy();
    expect(screen.getByText("Impact panel mounted")).toBeTruthy();
    expect(screen.queryByText("Dependencies panel mounted")).toBeNull();
  });
});
