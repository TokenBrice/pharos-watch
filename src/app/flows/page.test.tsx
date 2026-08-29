import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FlowsPage from "@/app/flows/page";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/hooks/use-mint-burn-flows", () => ({
  useMintBurnFlows: vi.fn(),
}));

vi.mock("@/components/flow-chart", () => ({
  FlowChart: () => <div>chart</div>,
}));

vi.mock("@/components/flow-table", () => ({
  FlowTable: ({ coins }: { coins: Array<{
    pressureShiftScore: number | null;
    pressureShiftState: string;
    netFlowDirection24h: string;
  }> }) => (
    <div>
      table {coins.map((coin) => (
        <span key={`${coin.pressureShiftScore}|${coin.pressureShiftState}|${coin.netFlowDirection24h}`}>
          {`${coin.pressureShiftScore}|${coin.pressureShiftState}|${coin.netFlowDirection24h}`}
        </span>
      ))}
    </div>
  ),
}));

vi.mock("@/components/flow-brrr-overview", () => ({
  FlowBrrrOverview: () => <div>overview</div>,
}));

vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: () => null,
}));

const mockUseMintBurnFlows = vi.mocked(useMintBurnFlows);

function makeQueryResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    meta: null,
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
    ...overrides,
  };
}

function buildFlowData(syncWarning: string | null) {
  return {
    gauge: {
      score: 0,
      band: "NEUTRAL",
      intensitySemantics: "signed-v2",
      flightToQuality: false,
      flightIntensity: 0,
      trackedCoins: 1,
      trackedMcapUsd: 100_000_000_000,
    },
    coins: [makeMintBurnFlowCoin()],
    hourly: [],
    updatedAt: Math.floor(Date.now() / 1000),
    windowHours: 24,
    scope: {
      chainIds: ["ethereum", "arbitrum"],
      label: "Configured issuance chains",
    },
    sync: {
      lastSuccessfulSyncAt: Math.floor(Date.now() / 1000) - 3_000,
      freshnessStatus: "degraded",
      warning: syncWarning,
      criticalLaneHealthy: false,
    },
  };
}

describe("FlowsPage", () => {
  beforeEach(() => {
    mockUseMintBurnFlows.mockReset();
  });

  it("suppresses the generic stale-data banner when a specific sync warning is present", () => {
    const syncWarning = "Mint/burn sync freshness is degraded versus the 30-minute cron cadence.";

    mockUseMintBurnFlows.mockImplementation((hours = 24) => {
      if (hours === 168) {
        return makeQueryResult({
          data: buildFlowData(syncWarning),
        }) as unknown as ReturnType<typeof useMintBurnFlows>;
      }

      return makeQueryResult({
        data: buildFlowData(syncWarning),
        meta: {
          updatedAt: Math.floor(Date.now() / 1000) - 3_000,
          ageSeconds: 3_000,
          status: "degraded",
        },
      }) as unknown as ReturnType<typeof useMintBurnFlows>;
    });

    const html = renderToStaticMarkup(<FlowsPage />);

    expect(html).toContain(syncWarning);
    expect(html).not.toContain("Data may be delayed");
  });

  it("passes signed values and states to the flow table unchanged", () => {
    mockUseMintBurnFlows.mockReturnValue(makeQueryResult({
      data: buildFlowData(null),
    }) as unknown as ReturnType<typeof useMintBurnFlows>);

    const html = renderToStaticMarkup(<FlowsPage />);

    expect(html).toContain("-42|worsening|burning");
  });

  it("still shows the generic stale-data banner when no sync-specific warning exists", () => {
    mockUseMintBurnFlows.mockImplementation((hours = 24) => {
      if (hours === 168) {
        return makeQueryResult({
          data: buildFlowData(null),
        }) as unknown as ReturnType<typeof useMintBurnFlows>;
      }

      return makeQueryResult({
        data: buildFlowData(null),
        meta: {
          updatedAt: Math.floor(Date.now() / 1000) - 3_000,
          ageSeconds: 3_000,
          status: "degraded",
          warning: '110 - "Response is stale"',
        },
      }) as unknown as ReturnType<typeof useMintBurnFlows>;
    });

    const html = renderToStaticMarkup(<FlowsPage />);

    expect(html).not.toContain("Mint/burn sync freshness is degraded");
    expect(html).toContain("Live refresh is running behind");
  });

  it("shows the generic stale-data banner when fresh API metadata accompanies a retry error", () => {
    const refreshError = new Error("network");

    mockUseMintBurnFlows.mockImplementation((hours = 24) => {
      if (hours === 168) {
        return makeQueryResult({
          data: buildFlowData(null),
        }) as unknown as ReturnType<typeof useMintBurnFlows>;
      }

      return makeQueryResult({
        data: buildFlowData(null),
        error: refreshError,
        meta: {
          updatedAt: Math.floor(Date.now() / 1000) - 120,
          ageSeconds: 120,
          status: "fresh",
        },
      }) as unknown as ReturnType<typeof useMintBurnFlows>;
    });

    const html = renderToStaticMarkup(<FlowsPage />);

    expect(html).toContain("Live refresh is running behind");
    expect(html).not.toContain("Showing an older snapshot");
  });

  it("emits one breadcrumb json-ld from the shell and keeps the FAQ json-ld in layout", () => {
    mockUseMintBurnFlows.mockImplementation((hours = 24) => {
      if (hours === 168) {
        return makeQueryResult({
          data: buildFlowData(null),
        }) as unknown as ReturnType<typeof useMintBurnFlows>;
      }

      return makeQueryResult({
        data: buildFlowData(null),
        meta: {
          updatedAt: Math.floor(Date.now() / 1000) - 120,
          ageSeconds: 120,
          status: "fresh",
        },
      }) as unknown as ReturnType<typeof useMintBurnFlows>;
    });

    const html = renderToStaticMarkup(<FlowsPage />);

    expect(html.match(/"@type":"BreadcrumbList"/g)).toHaveLength(1);
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).not.toContain("This section failed to load. Try refreshing the page.");
  });
});
