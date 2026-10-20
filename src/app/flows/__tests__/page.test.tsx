// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MintBurnFlowsResponse } from "@shared/types";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

const useMintBurnFlowsMock = vi.hoisted(() => vi.fn());
const flowGaugeHeroMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/hooks/use-mint-burn-flows", () => ({
  useMintBurnFlows: useMintBurnFlowsMock,
}));

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("@/components/feature-page-shell", () => ({
  FeaturePageShell: ({ children, headerSupplement }: { children: ReactNode; headerSupplement?: ReactNode }) => (
    <>{headerSupplement}{children}</>
  ),
}));
vi.mock("@/components/flow-chart", () => ({ FlowChart: () => null }));
vi.mock("@/components/flow-table", () => ({ FlowTable: () => null }));
vi.mock("@/components/flow-gauge-hero", () => ({ FlowGaugeHero: flowGaugeHeroMock }));
vi.mock("@/components/faq-section", () => ({ FaqSection: () => null }));
vi.mock("@/components/control-pill-toggle", () => ({
  ControlPillToggle: ({ onChange }: { onChange: (hours: number) => void }) => (
    <button type="button" onClick={() => onChange(720)}>30d</button>
  ),
}));

import FlowsClient from "@/app/flows/client";

function makeFlowData(): MintBurnFlowsResponse {
  return {
    gauge: {
      score: 0,
      band: "NEUTRAL",
      intensitySemantics: "signed-v2",
      flightToQuality: false,
      flightIntensity: 0,
      trackedCoins: 1,
      trackedMcapUsd: 100_000_000,
    },
    coins: [makeMintBurnFlowCoin()],
    hourly: [],
    updatedAt: Math.floor(Date.now() / 1000),
    windowHours: 24,
    scope: { chainIds: ["ethereum"], label: "Configured issuance chains" },
    sync: {
      lastSuccessfulSyncAt: Math.floor(Date.now() / 1000),
      freshnessStatus: "fresh",
      warning: null,
      criticalLaneHealthy: true,
    },
  };
}

function makeQueryResult(overrides: Record<string, unknown> = {}) {
  return {
    data: makeFlowData(),
    meta: null,
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FlowsClient", () => {
  it("passes the summary evidence window to the hero and labels the footer as a sync clock", () => {
    const summary = makeFlowData();
    summary.window = {
      start: Date.UTC(2026, 0, 17, 16) / 1000,
      end: Date.UTC(2026, 0, 18, 16) / 1000,
      semantics: "closed-utc-hours",
      watermark: { timestamp: Date.UTC(2026, 0, 18, 16) / 1000, ageSec: 7200, maxAgeSec: 28800, unavailableReason: null },
    };
    useMintBurnFlowsMock.mockReturnValue(makeQueryResult({ data: summary }));
    render(<FlowsClient faqItems={[]} />);
    expect(flowGaugeHeroMock).toHaveBeenCalledWith(expect.objectContaining({ window: summary.window }), undefined);
    expect(screen.getByText(/Critical-lane sync every .* min; evidence may lag/)).toBeTruthy();
    expect(screen.queryByText(/Refreshed every/)).toBeNull();
  });

  it("defers the 30-day variant until selected and reuses the weekly chart for the 7-day receipt", () => {
    render(<FlowsClient faqItems={[]} />);
    expect(useMintBurnFlowsMock).toHaveBeenCalledWith(24);
    expect(useMintBurnFlowsMock).toHaveBeenCalledWith(168, { enabled: true });
    expect(useMintBurnFlowsMock).toHaveBeenCalledWith(168, { enabled: false });
    expect(useMintBurnFlowsMock).not.toHaveBeenCalledWith(720, expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "30d" }));
    expect(useMintBurnFlowsMock).toHaveBeenLastCalledWith(168, { enabled: true });
    expect(useMintBurnFlowsMock).toHaveBeenCalledWith(720, { enabled: true });
  });

  beforeEach(() => {
    useMintBurnFlowsMock.mockImplementation((hours: number) => {
      if (hours === 168) {
        return makeQueryResult({ data: undefined, dataUpdatedAt: 0, error: new Error("weekly flow refresh failed") });
      }
      return makeQueryResult();
    });
  });

  it("surfaces a standalone weekly query failure in the error notice", () => {
    render(<FlowsClient faqItems={[]} />);

    expect(screen.getByText("Refresh delayed")).toBeTruthy();
  });
});
