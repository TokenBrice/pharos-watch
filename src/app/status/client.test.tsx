// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";
import type { HealthResponse, PublicStatusHistoryResponse } from "@shared/types";
import { PUBLIC_STATUS_COMPONENT_IDS } from "@shared/types/status";

const { useHealthMock, useHistoryMock, useProbesMock } = vi.hoisted(() => ({
  useHealthMock: vi.fn(),
  useHistoryMock: vi.fn(),
  useProbesMock: vi.fn(),
}));
vi.mock("@/hooks/api-hooks", () => ({ useHealth: useHealthMock }));
vi.mock("@/hooks/use-public-status-history", () => ({ usePublicStatusHistory: useHistoryMock }));
vi.mock("@/hooks/use-endpoint-probes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-endpoint-probes")>()),
  usePublicEndpointProbes: useProbesMock,
}));
vi.mock("@/components/feature-page-shell", () => ({
  FeaturePageShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/faq-section", () => ({ FaqSection: () => null }));

import StatusClient from "./client";

const emptyHistory: PublicStatusHistoryResponse = {
  timestamp: 1_790_000_000,
  currentStatus: "healthy",
  lastChangedAt: null,
  transitions: [],
  publicHistoryStartedAt: 1_780_000_000,
  componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, 1_780_000_000])),
  hasMore: false,
};

function mockHealth(data: HealthResponse | undefined, overrides: Record<string, unknown> = {}) {
  useHealthMock.mockReturnValue({
    data, error: null, isLoading: false, refetch: vi.fn(), dataUpdatedAt: Date.now(), ...overrides,
  });
}

function openIntegrators() {
  const details = screen.getByText("For integrators").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

beforeEach(() => {
  mockHealth(makeHealthyHealthResponse());
  useProbesMock.mockReturnValue({
    data: undefined, error: null, isLoading: false, refetch: vi.fn(), dataUpdatedAt: 0,
  });
  useHistoryMock.mockReturnValue({ data: emptyHistory, isLoading: false, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("public verdict", () => {
  it("renders held Safety Scores as a separate degraded row", () => {
    const health = makeHealthyHealthResponse();
    health.safetyScorePublication = {
      ...health.safetyScorePublication!, status: "held",
      attemptedAtSec: health.timestamp, heldSinceSec: health.timestamp - 60,
      reasons: [{ code: "redemption-stale" }],
    };
    mockHealth(health);
    render(<StatusClient faqItems={[]} />);
    expect(screen.getByRole("heading", { name: "Degraded: Safety Scores" })).toBeTruthy();
    expect(within(screen.getByTestId("public-component-safety-scores")).getByText("Degraded")).toBeTruthy();
    expect(within(screen.getByTestId("public-component-risk-signals")).getByText("Operational")).toBeTruthy();
  });

  it("reads the worker headline and keeps operational quiet", () => {
    mockHealth({
      ...makeHealthyHealthResponse(),
      headline: { state: "operational", title: "All systems operational", affected: [] },
    });
    render(<StatusClient faqItems={[]} />);
    const verdict = screen.getByRole("heading", { name: "All systems operational" }).closest("section")!;
    expect(verdict.className).not.toContain("border-l-");
    expect(within(verdict).getByText(/Checked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByText(/Public surface/)).toBeNull();
  });

  it("derives the headline from the shared projection when an older payload has none", () => {
    mockHealth({ ...makeHealthyHealthResponse(), status: "degraded", warnings: [] });
    render(<StatusClient faqItems={[]} />);
    const verdict = screen.getByRole("heading", { name: "Degraded: Website and API" }).closest("section")!;
    expect(verdict.className).toContain("border-l-state-warn-solid");
  });

  it("offers a refresh only when the last fetch failed or is past its budget", () => {
    mockHealth(makeHealthyHealthResponse(), { error: new Error("network down") });
    render(<StatusClient faqItems={[]} />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    const fetchNotice = screen.getByText("The status check could not be reached. Showing the last good reading.");
    // The raw error stays reachable on hover, never as visible copy.
    expect(fetchNotice.getAttribute("title")).toBe("network down");
    cleanup();

    vi.useFakeTimers();
    const now = 1_790_000_000_000;
    vi.setSystemTime(now);
    mockHealth(makeHealthyHealthResponse(), { dataUpdatedAt: now - 1_800_001 });
    render(<StatusClient faqItems={[]} />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    cleanup();

    mockHealth(makeHealthyHealthResponse(), { dataUpdatedAt: now - 1_800_000 });
    render(<StatusClient faqItems={[]} />);
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("shows a loading skeleton, not an error, while health is pending", () => {
    mockHealth(undefined, { isLoading: true });
    render(<StatusClient faqItems={[]} />);
    expect(screen.getByLabelText("Loading status")).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});

describe("public history availability", () => {
  it("shows pending history as loading, never as unavailable or empty", () => {
    useHistoryMock.mockReturnValue({ data: undefined, isLoading: true, error: null });
    render(<StatusClient faqItems={[]} />);
    expect(screen.getByText("Loading incident history")).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.queryByText(/No incidents recorded/)).toBeNull();
  });

  it("does not turn a failed history read into a quiet history, even with retained data", () => {
    useHistoryMock.mockReturnValue({ data: emptyHistory, isLoading: false, error: new Error("history unavailable") });
    render(<StatusClient faqItems={[]} />);
    expect(screen.getByText("Incident history could not be loaded: history unavailable")).toBeTruthy();
    expect(screen.getByText(/Component history could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No incidents recorded/)).toBeNull();
    expect(screen.queryByRole("img", { name: /last 30 days/ })).toBeNull();
  });

  it("renders an observed empty history as empty, with per-component bars", () => {
    render(<StatusClient faqItems={[]} />);
    expect(screen.getByText("No incidents recorded in the last 30 days.")).toBeTruthy();
    expect(screen.getByRole("img", { name: /^Yield, last 30 days/ })).toBeTruthy();
  });
});

describe("for integrators", () => {
  it("never presents an unavailable circuit read as all closed", () => {
    mockHealth({
      ...makeHealthyHealthResponse(), circuits: null, circuitsUnavailableReason: "circuits-read-failed",
      status: "degraded", warnings: ["circuit-query-failed"],
    });
    render(<StatusClient faqItems={[]} />);
    openIntegrators();
    expect(screen.getByText("Circuit breaker evidence unavailable (circuits-read-failed).")).toBeTruthy();
    expect(screen.queryByText("All closed")).toBeNull();
  });

  it("renders background computation delay without internal lane names", () => {
    const health = makeHealthyHealthResponse();
    health.status = "degraded";
    health.warnings = ["heavy_scheduled_delivery_stalled"];
    health.schedulerLiveness!.heavy = {
      ...health.schedulerLiveness!.heavy, status: "degraded", ageSeconds: 1801,
      lastStartedAt: health.timestamp - 1801,
    };
    mockHealth(health);
    render(<StatusClient faqItems={[]} />);
    openIntegrators();
    expect(screen.getByText("Background computation lane")).toBeTruthy();
    expect(screen.queryByText("v9SupplyAttributionOffset")).toBeNull();
    expect(screen.getByText(/Delayed after 30m, degraded after 45m, outage after 1h 30m\./)).toBeTruthy();
  });

  it.each([
    ["pending", undefined, true, null, "Probing endpoints"],
    ["failed", undefined, false, new Error("probe read failed"), "Browser probes could not run: probe read failed"],
  ] as const)("keeps %s probe evidence distinct from a pass", (_label, data, isLoading, error, expected) => {
    useProbesMock.mockReturnValue({ data, isLoading, error, refetch: vi.fn(), dataUpdatedAt: 0 });
    render(<StatusClient faqItems={[]} />);
    openIntegrators();
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText("OK")).toBeNull();
  });
});
