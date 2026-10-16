// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryTabs } from "../history-tabs";

const hooks = vi.hoisted(() => ({
  legacy: { isLoading: false, error: null as Error | null, data: [] as unknown[] },
  v2: { isLoading: false, error: null as Error | null, data: { history: [] as unknown[] } },
  ddr: { error: null as Error | null, data: undefined as unknown },
}));

vi.mock("@/hooks/api-hooks", () => ({
  useSafetyScoreHistory: () => hooks.legacy,
  useSafetyScoreHistoryV2: () => hooks.v2,
  useDepegResolverReview: () => hooks.ddr,
}));
vi.mock("@/components/depeg-history", () => ({ DepegHistory: () => <div data-testid="depeg-panel" /> }));
vi.mock("@/components/stablecoin-detail/safety-score-history-section", () => ({
  SafetyScoreHistorySection: () => <div data-testid="grade-panel" />,
}));
vi.mock("@/components/stablecoin-detail/ddr-track-record-section", () => ({
  DdrTrackRecordSection: () => <div data-testid="ddr-panel" />,
}));

const depegProps = {
  observationStartedAt: null,
  hasPriceData: true,
  depegEventCoverageLimited: false,
  historyCoverage: null,
  recent90d: null,
  scoreWindowIncidentCount: null,
};

describe("HistoryTabs", () => {
  beforeEach(() => {
    hooks.legacy = { isLoading: false, error: null, data: [{ date: 1, grade: "A" }] };
    hooks.v2 = { isLoading: false, error: null, data: { history: [] } };
    hooks.ddr = { error: new Error("down"), data: undefined };
  });
  afterEach(() => {
    window.history.replaceState(null, "", "#");
  });

  it("renders one tab per module with content and only the active panel's module", () => {
    render(<HistoryTabs stablecoinId="usdc-circle" isNavToken={false} {...depegProps} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Grade", "Depeg", "DDR record"]);
    expect(screen.getByTestId("grade-panel")).toBeTruthy();
    expect(screen.queryByTestId("depeg-panel")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Depeg" }));
    expect(screen.getByTestId("depeg-panel")).toBeTruthy();
    expect(screen.queryByTestId("grade-panel")).toBeNull();
  });

  it("drops the grade tab once its history loads empty, and depeg/DDR for NAV tokens", () => {
    hooks.legacy = { isLoading: false, error: null, data: [] };
    const { container } = render(<HistoryTabs stablecoinId="nav" isNavToken {...depegProps} />);
    expect(container.firstChild).toBeNull();
  });

});
