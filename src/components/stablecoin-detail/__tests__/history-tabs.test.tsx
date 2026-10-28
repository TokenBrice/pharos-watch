// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryTabs } from "../history-tabs";

const hooks = vi.hoisted(() => ({
  legacy: vi.fn(),
  v2: vi.fn(),
  ddr: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useSafetyScoreHistory: hooks.legacy,
  useSafetyScoreHistoryV2: hooks.v2,
  useDepegResolverReview: hooks.ddr,
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

const preview = <div data-testid="depeg-preview">Latest 6 of 248 archived incidents</div>;

function mockHooks({
  grade = [{ date: 1, grade: "A" }] as unknown[],
  gradeLoading = false,
  gradeError = null as Error | null,
  ddrData = undefined as unknown,
  ddrError = null as Error | null,
} = {}) {
  hooks.legacy.mockReturnValue({ isLoading: gradeLoading, error: gradeError, data: grade });
  hooks.v2.mockReturnValue({ isLoading: gradeLoading, error: gradeError, data: { history: [] } });
  hooks.ddr.mockReturnValue({ error: ddrError, data: ddrData });
}

describe("HistoryTabs", () => {
  beforeEach(() => {
    mockHooks({ ddrError: new Error("down") });
  });
  afterEach(() => {
    window.history.replaceState(null, "", "#");
    vi.clearAllMocks();
  });

  it("keeps the retained preview in the inactive Depeg panel before the live gate opens", () => {
    const { container } = render(
      <HistoryTabs stablecoinId="usdc-circle" isNavToken={false} historyActive={false}
        depegHistoryPreview={preview} {...depegProps} />,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Grade", "Depeg"]);
    expect(screen.getByTestId("depeg-preview")).toBeTruthy();
    expect(screen.queryByTestId("grade-panel")).toBeNull();
    expect(screen.queryByTestId("depeg-panel")).toBeNull();
    expect(container.querySelectorAll("#depeg-history")).toHaveLength(1);
    expect(container.querySelector("#depeg-history")?.hasAttribute("hidden")).toBe(true);
    // No live availability read, grade query or event crawl before the gate.
    expect(hooks.legacy).not.toHaveBeenCalled();
    expect(hooks.v2).not.toHaveBeenCalled();
    expect(hooks.ddr).not.toHaveBeenCalled();
  });

  it("mounts only the active live module once the History viewport gate opens", async () => {
    render(
      <HistoryTabs stablecoinId="usdc-circle" isNavToken={false} historyActive
        depegHistoryPreview={preview} {...depegProps} />,
    );

    expect(await screen.findByTestId("grade-panel")).toBeTruthy();
    expect(screen.queryByTestId("depeg-panel")).toBeNull();
    expect(hooks.legacy).toHaveBeenCalledWith("usdc-circle");

    fireEvent.click(screen.getByRole("tab", { name: "Depeg" }));
    expect(await screen.findByTestId("depeg-panel")).toBeTruthy();
    expect(screen.queryByTestId("grade-panel")).toBeNull();
    expect(screen.getByTestId("depeg-preview")).toBeTruthy();
  });

  it("drops the grade tab once its history loads empty, leaving Depeg active", async () => {
    mockHooks({ grade: [], ddrError: null, ddrData: undefined });
    render(
      <HistoryTabs stablecoinId="usdc-circle" isNavToken={false} historyActive
        depegHistoryPreview={preview} {...depegProps} />,
    );

    expect(await screen.findByTestId("depeg-panel")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("grade-panel")).toBeNull());
    // One remaining view needs no tablist; the Depeg panel is the only one.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("depeg-preview")).toBeTruthy();
  });

  it("renders nothing for a NAV profile with no grade history and never mounts its preview", async () => {
    mockHooks({ grade: [] });
    const { container } = render(
      <HistoryTabs stablecoinId="nav" isNavToken historyActive
        depegHistoryPreview={preview} {...depegProps} />,
    );

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByTestId("depeg-preview")).toBeNull();
  });

  it("reveals the Depeg panel for a hash naming the panel", () => {
    window.history.replaceState(null, "", "#depeg-history");
    render(
      <HistoryTabs stablecoinId="usdc-circle" isNavToken={false} historyActive={false}
        depegHistoryPreview={preview} {...depegProps} />,
    );

    const tab = screen.getByRole("tab", { name: "Depeg" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("depeg-history")?.hasAttribute("hidden")).toBe(false);
    expect(tab.getAttribute("aria-controls")).toBe("depeg-history");
  });

  it("keeps one anchor per panel and exposes inactive panels as hidden, not active", () => {
    const { container } = render(
      <HistoryTabs stablecoinId="usdc-circle" isNavToken={false} historyActive
        depegHistoryPreview={preview} {...depegProps} />,
    );

    expect(container.querySelectorAll("#depeg-history")).toHaveLength(1);
    expect(container.querySelectorAll("#grade-history")).toHaveLength(1);
    expect(container.querySelectorAll("#ddr-track-record")).toHaveLength(1);
    expect(container.querySelector("#depeg-history")?.getAttribute("role")).toBe("tabpanel");
    expect(container.querySelector("#depeg-history")?.getAttribute("aria-labelledby")).toBe("history-tab-depeg");
    expect(container.querySelector("#depeg-history")?.hasAttribute("hidden")).toBe(true);
    expect(screen.getByRole("tab", { name: "Grade" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Depeg" }).getAttribute("aria-selected")).toBe("false");
  });

  it("keeps the preview node mounted across tab changes", async () => {
    render(
      <HistoryTabs stablecoinId="usdc-circle" isNavToken={false} historyActive
        depegHistoryPreview={preview} {...depegProps} />,
    );
    const before = screen.getByTestId("depeg-preview");
    fireEvent.click(screen.getByRole("tab", { name: "Depeg" }));
    fireEvent.click(screen.getByRole("tab", { name: "Grade" }));
    expect(screen.getByTestId("depeg-preview")).toBe(before);
  });
});
