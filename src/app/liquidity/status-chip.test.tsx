// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { LiquidityStatusChip } from "./status-chip";

const stats = { totalTvlUnavailableReason: null } as LiquidityStatsData;

describe("LiquidityStatusChip", () => {
  it("names a 110 warning as stale and falls back to the endpoint's fresh budget", () => {
    render(createElement(LiquidityStatusChip, {
      stats,
      meta: { status: "degraded", warning: '110 - "Response is stale (999s old, fresh budget 115200s)"' },
    }));
    const chip = screen.getByRole("button", { name: /Stale data/ });
    expect(chip.getAttribute("data-reason-codes")).toBe("api-degraded warn-110");
    fireEvent.click(chip);
    const budgetHours = Math.round((API_FRESHNESS_MAX_AGE_SEC.dexLiquidity * FRESHNESS_RATIOS.FRESH) / 3600);
    expect(document.body.textContent).toContain(`fresh budget ${budgetHours}h`);
    expect(screen.getByText("Response is stale.")).toBeTruthy();
  });

  it("renders nothing for fresh data and a reasoned chip for withheld depth", () => {
    const { container, unmount } = render(createElement(LiquidityStatusChip, {
      stats,
      meta: { status: "fresh", updatedAt: 1, ageSeconds: 1, warning: null },
    }));
    expect(container.textContent).toBe("");
    unmount();

    render(createElement(LiquidityStatusChip, {
      stats: { totalTvlUnavailableReason: "invalid-coverage-evidence" } as LiquidityStatsData,
      meta: null,
    }));
    expect(screen.getByRole("button", { name: /Depth unavailable/ }).getAttribute("data-reason-codes"))
      .toBe("invalid-coverage-evidence");
  });
});
