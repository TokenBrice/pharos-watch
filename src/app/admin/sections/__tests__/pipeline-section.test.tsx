// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { degraded, makeHealthyStatusResponse } from "@/test-utils/status-fixtures";

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
vi.mock("@/components/status/discovery-candidates", () => ({
  DiscoveryCandidatesCard: ({ onDismissed }: { onDismissed: () => void }) => (
    <div>
      Discovery panel mounted
      <button type="button" onClick={onDismissed}>Dismiss candidate</button>
    </div>
  ),
}));

import { PipelineSection } from "../pipeline-section";

beforeEach(() => {
  window.history.replaceState({}, "", "/admin/pipeline/?view=quality");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PipelineSection", () => {
  it("syncs keyboard tab selection to the URL and mounts only the active mode", async () => {
    render(<PipelineSection data={makeHealthyStatusResponse()} handleRefresh={vi.fn()} />);

    const qualityTab = screen.getByRole("tab", { name: /^Quality/ });
    const marketsTab = screen.getByRole("tab", { name: /^Markets/ });
    expect(screen.getByText("Quality panel mounted")).toBeTruthy();
    expect(screen.queryByText("Price source panel mounted")).toBeNull();
    expect(qualityTab.getAttribute("aria-controls")).toBe("pipeline-panel-quality");
    expect(marketsTab.getAttribute("aria-controls")).toBeNull();

    fireEvent.keyDown(qualityTab, { key: "ArrowRight" });

    await waitFor(() => expect(screen.getByText("Price source panel mounted")).toBeTruthy());
    expect(screen.getByText("Liquidity panel mounted")).toBeTruthy();
    expect(screen.getByText("CoinGecko panel mounted")).toBeTruthy();
    expect(screen.queryByText("Quality panel mounted")).toBeNull();
    expect(window.location.search).toContain("view=markets");
    expect(document.activeElement).toBe(marketsTab);
    expect(marketsTab.getAttribute("aria-controls")).toBe("pipeline-panel-markets");
    expect(qualityTab.getAttribute("aria-controls")).toBeNull();
  });

  it("honors a URL-selected mode on mount", async () => {
    window.history.replaceState({}, "", "/admin/pipeline/?view=integrity");
    render(<PipelineSection data={makeHealthyStatusResponse()} handleRefresh={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Integrity panel mounted")).toBeTruthy());
    expect(screen.getByRole("tab", { name: /^Integrity/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Quality panel mounted")).toBeNull();
  });

  it("surfaces loader failures for inactive modes with human and raw labels", () => {
    const base = makeHealthyStatusResponse();
    const data = degraded(base, {
      sectionErrors: {
        classificationWarnings: {
          code: "classification_query_failed",
          message: "Classification loader timed out",
        },
      },
    });

    render(<PipelineSection data={data} handleRefresh={vi.fn()} />);

    expect(screen.getByText("Loader coverage is incomplete")).toBeTruthy();
    expect(screen.getByText("Classification warnings")).toBeTruthy();
    expect(screen.getByText(/classificationWarnings · classification_query_failed/)).toBeTruthy();
    expect(screen.getByText("Quality panel mounted")).toBeTruthy();
    expect(screen.queryByText("Metadata panel mounted")).toBeNull();
  });

  it("retains the status refresh callback for Discovery dismissals", async () => {
    const handleRefresh = vi.fn();
    render(<PipelineSection data={makeHealthyStatusResponse()} handleRefresh={handleRefresh} />);

    fireEvent.click(screen.getByRole("tab", { name: /^Discovery/ }));
    await waitFor(() => expect(screen.getByText("Discovery panel mounted")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss candidate" }));

    expect(handleRefresh).toHaveBeenCalledTimes(1);
  });
});
