// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MintBurnFlowsResponse } from "@shared/types";
import { makeMintBurnFlowCoin } from "@/test-utils/mint-burn-fixtures";

const useMintBurnFlowsMock = vi.hoisted(() => vi.fn());

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
vi.mock("@/components/flow-brrr-overview", () => ({ FlowBrrrOverview: () => null }));
vi.mock("@/components/faq-section", () => ({ FaqSection: () => null }));
vi.mock("@/components/control-pill-toggle", () => ({ ControlPillToggle: () => null }));

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
