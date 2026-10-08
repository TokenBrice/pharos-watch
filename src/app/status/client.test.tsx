// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";
import type { PublicStatusHistoryResponse } from "@shared/types";

const { useHealthMock, useHistoryMock } = vi.hoisted(() => ({
  useHealthMock: vi.fn(),
  useHistoryMock: vi.fn(),
}));
vi.mock("@/hooks/api-hooks", () => ({ useHealth: useHealthMock }));
vi.mock("@/hooks/use-public-status-history", () => ({ usePublicStatusHistory: useHistoryMock }));
vi.mock("@/hooks/use-endpoint-probes", () => ({
  usePublicEndpointProbes: () => ({ data: undefined, error: null, isLoading: false, refetch: vi.fn() }),
}));
vi.mock("@/components/feature-page-shell", () => ({
  FeaturePageShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/faq-section", () => ({ FaqSection: () => null }));
vi.mock("@/components/status/public-status-hero", () => ({ PublicStatusHero: () => null }));
vi.mock("@/components/status/public-service-summary-section", () => ({ PublicServiceSummarySection: () => null }));
vi.mock("@/components/status/public-status-reliability-section", () => ({ PublicStatusReliabilitySection: () => null }));

import StatusClient from "./client";

const emptyHistory: PublicStatusHistoryResponse = {
  timestamp: 1_790_000_000,
  currentStatus: "healthy",
  lastChangedAt: null,
  transitions: [],
};

beforeEach(() => {
  useHealthMock.mockReturnValue({
    data: makeHealthyHealthResponse(), error: null, isLoading: false,
    refetch: vi.fn(), dataUpdatedAt: Date.now(),
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("public incident history availability", () => {
  it("renders heavy delivery loss while the public scheduler remains healthy", () => {
    const health = makeHealthyHealthResponse();
    health.status = "degraded";
    health.warnings = ["heavy_scheduled_delivery_stalled"];
    health.schedulerLiveness!.heavy = {
      ...health.schedulerLiveness!.heavy, status: "degraded", ageSeconds: 1801,
      lastStartedAt: health.timestamp - 1801,
    };
    useHealthMock.mockReturnValue({ data: health, error: null, isLoading: false, refetch: vi.fn(), dataUpdatedAt: Date.now() });
    useHistoryMock.mockReturnValue({ data: emptyHistory, isLoading: false, error: null });
    render(<StatusClient faqItems={[]} />);
    expect(screen.getByText("Heavy Worker delivery")).toBeTruthy();
    expect(screen.getByText("v9SupplyAttributionOffset")).toBeTruthy();
    expect(screen.getByText(/warning >1800s · stale >2700s/)).toBeTruthy();
    expect(screen.getByText(/· healthy/)).toBeTruthy();
  });
  it.each(["loading", "failed"] as const)("does not turn %s history into an empty observation", (state) => {
    useHistoryMock.mockReturnValue({
      data: undefined,
      isLoading: state === "loading",
      error: state === "failed" ? new Error("history unavailable") : null,
    });
    render(<StatusClient faqItems={[]} />);

    expect(screen.queryByRole("img", { name: /status runway/ })).toBeNull();
    expect(screen.getByText(/last 30 days cannot be shown/)).toBeTruthy();
    expect(screen.queryByText(/No status changes recorded/)).toBeNull();
  });

  it("renders a successfully observed empty history as empty", () => {
    useHistoryMock.mockReturnValue({ data: emptyHistory, isLoading: false, error: null });
    render(<StatusClient faqItems={[]} />);

    expect(screen.getByRole("img", { name: /status runway/ })).toBeTruthy();
    expect(screen.getByText(/No status changes recorded/)).toBeTruthy();
    expect(screen.queryByText(/last 30 days cannot be shown/)).toBeNull();
  });

  it("does not present a retained runway as current after a refresh failure", () => {
    useHistoryMock.mockReturnValue({
      data: { ...emptyHistory, lastChangedAt: 1_789_000_000, transitions: [{
        id: 1, from: "degraded", to: "healthy", transitionType: "recover",
        reason: "Recovery", at: 1_789_000_000,
      }] },
      isLoading: false,
      error: new Error("history unavailable"),
    });
    render(<StatusClient faqItems={[]} />);

    expect(screen.queryByRole("img", { name: /status runway/ })).toBeNull();
    expect(screen.queryByText(/healthy for \d+d/)).toBeNull();
    expect(screen.getByText(/last 30 days cannot be shown/)).toBeTruthy();
  });
});
