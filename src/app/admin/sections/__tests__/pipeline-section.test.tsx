// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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

import { PipelineSection } from "../pipeline-section";

beforeEach(() => {
  window.history.replaceState({}, "", "/admin/pipeline/?view=quality");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PipelineSection", () => {

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
