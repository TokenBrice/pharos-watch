// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiquidityStatsData } from "@/components/liquidity-stats-types";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { LiquidityStatusChip } from "./status-chip";
import type { ApiMeta } from "@/lib/api";

afterEach(() => vi.useRealTimers());
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

const stats = { totalTvlUnavailableReason: null } as LiquidityStatsData;

describe("LiquidityStatusChip", () => {
  it("names a 110 warning as stale and falls back to the endpoint's fresh budget", () => {
    render(createElement(LiquidityStatusChip, {
      stats,
      meta: { status: "degraded", warning: '110 - "Response is stale (999s old, fresh budget 115200s)"' },
    }));
    const chip = screen.getByRole("button", { name: /Stale data/ });
    expect(chip.getAttribute("data-reason-codes")).toContain("warn-110");
    fireEvent.click(chip);
    const budgetHours = Math.round((API_FRESHNESS_MAX_AGE_SEC.dexLiquidity * FRESHNESS_RATIOS.FRESH) / 3600);
    expect(document.body.textContent).toContain(`fresh budget ${budgetHours}h`);
    expect(screen.getByText("Response is stale.")).toBeTruthy();
  });

  it("renders nothing for fresh data and a reasoned chip for withheld depth", () => {
    const { container, unmount } = render(createElement(LiquidityStatusChip, {
      stats,
      meta: { status: "fresh", updatedAt: Math.floor(Date.now() / 1000), ageSeconds: 1, warning: null },
      dataUpdatedAt: Date.now(),
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

it("ages saved fresh liquidity metadata to delayed and stale without fetching or rerendering", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const receipt = Date.now();
  render(<LiquidityStatusChip stats={stats} dataUpdatedAt={receipt} meta={{
    updatedAt: receipt / 1000, status: "fresh", ageSeconds: 0,
    freshBudgetSec: 60, degradedBudgetSec: 120,
  }} />);
  expect(screen.queryByRole("button")).toBeNull();
  act(() => vi.advanceTimersByTime(50));
  act(() => vi.advanceTimersByTime(60_001));
  expect(screen.getByRole("button", { name: /Delayed data/ })).toBeTruthy();
  act(() => vi.advanceTimersByTime(60_000));
  const chip = screen.getByRole("button", { name: /Stale data/ });
  fireEvent.click(chip);
  expect(document.querySelector("time")?.getAttribute("datetime")).toBe(new Date(receipt).toISOString());
});

it.each([
  { meta: { updatedAt: Math.floor(Date.now() / 1000) - 3 * 86_400, status: "fresh" }, label: "Stale data" },
  { meta: { updatedAt: null, status: "unknown", ageSeconds: null }, label: "Data unavailable" },
  { meta: { updatedAt: Math.floor(Date.now() / 1000), status: "fresh", dependencies: { pools: { status: "stale", reason: "pool-old" } } }, label: "Data warning" },
] as { meta: ApiMeta; label: string }[])("assesses $label from the producer rather than the new receipt", ({ meta, label }) => {
  const receipt = Date.now();
  const { rerender } = render(<LiquidityStatusChip stats={stats} meta={meta} dataUpdatedAt={receipt} />);
  const chip = screen.getByRole("button", { name: (name) => name.includes(label) });
  fireEvent.click(chip);
  const producerTime = meta.updatedAt != null ? new Date(meta.updatedAt * 1000).toISOString() : null;
  expect(document.querySelector("time")?.getAttribute("datetime") ?? null).toBe(producerTime);
  if (producerTime === null) expect(screen.getByText(/Snapshot time unknown/)).toBeTruthy();
  rerender(<LiquidityStatusChip stats={stats} meta={meta} dataUpdatedAt={receipt + 30_000} />);
  expect(screen.getByRole("button", { name: (name) => name.includes(label) })).toBeTruthy();
});

it("keeps the producer clock while qualifying a failed refresh with saved depth", () => {
  const receipt = Date.now();
  const updatedAt = Math.floor(receipt / 1000) - 60;
  render(<LiquidityStatusChip stats={stats} dataUpdatedAt={receipt} error={new Error("offline")}
    meta={{ updatedAt, status: "fresh" }} />);
  fireEvent.click(screen.getByRole("button", { name: /Refresh failed/ }));
  expect(document.querySelector("time")?.getAttribute("datetime")).toBe(new Date(updatedAt * 1000).toISOString());
  expect(screen.getByText(/Using last successful data while refresh retries/)).toBeTruthy();
});
