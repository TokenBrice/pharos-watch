// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  FundingKpiRow,
  DonorList,
} from "../funding-page-sections";
import type { Donation } from "@shared/lib/funding/schema";
import type { ComponentProps } from "react";

type KpiSummary = ComponentProps<typeof FundingKpiRow>["summary"];

function kpiSummary(overrides: Partial<KpiSummary> = {}): KpiSummary {
  return {
    currentMonthCommunityUsd: 300,
    currentMonthFounderUsd: 1000,
    lifetimeCommunityUsd: 300,
    lifetimeFounderUsd: 3000,
    lifetimeCommunityDonorCount: 2,
    ...overrides,
  };
}

describe("FundingKpiRow", () => {
  it("renders numeric KPIs when there is community history", () => {
    render(<FundingKpiRow summary={kpiSummary()} monthlyTargetUsd={1540} />);
    expect(screen.getByText("This month coverage")).toBeTruthy();
    // 300 / 1540 ≈ 19%
    expect(screen.getByText("19%")).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "Monthly funding coverage" });
    expect(progress.getAttribute("aria-valuenow")).toBe("19");
    expect(screen.getByText("Community support")).toBeTruthy();
    expect(screen.getByText(/from 2 supporters/)).toBeTruthy();
    expect(screen.getByText("Recurring Giveth")).toBeTruthy();
    expect(screen.getByText(/Donations keep Pharos freely accessible/)).toBeTruthy();
  });

  it("renders <1% when monthly coverage is positive but rounds to zero", () => {
    render(
      <FundingKpiRow
        summary={kpiSummary({ currentMonthCommunityUsd: 1.24, lifetimeCommunityDonorCount: 1 })}
        monthlyTargetUsd={1709}
      />,
    );
    expect(screen.getByText("<1%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toContain("<1%");
  });

  it("shows cold-start copy when lifetime community is zero", () => {
    render(
      <FundingKpiRow
        summary={kpiSummary({
          currentMonthCommunityUsd: 0,
          lifetimeCommunityUsd: 0,
          lifetimeCommunityDonorCount: 0,
        })}
        monthlyTargetUsd={1540}
      />,
    );
    expect(screen.getByText("Tracking begins")).toBeTruthy();
    expect(screen.getByText("Be the first")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toContain("Tracking begins");
  });
});

describe("DonorList", () => {
  const now = Math.floor(Date.UTC(2026, 3, 18) / 1000);

  it("hides founder rows and shows community rows with display names", () => {
    const donations: Donation[] = [
      {
        chain: "ethereum",
        tx_hash: "0xabc",
        block_timestamp: now - 3600,
        from_address: "0x1",
        display: "alice.eth",
        kind: "community",
        asset_symbol: "ETH",
        token_address: null,
        amount_decimal: 0.1,
        usd_at_receipt: 300,
        price_note: "coingecko-historical-2026-04-18",
      },
      {
        chain: "ethereum",
        tx_hash: "0xdef",
        block_timestamp: now - 7200,
        from_address: "0xf",
        display: "TokenBrice (founder subsidy)",
        kind: "founder",
        asset_symbol: "ETH",
        token_address: null,
        amount_decimal: 0.3,
        usd_at_receipt: 1000,
        price_note: "coingecko-historical-2026-04-18",
      },
    ];
    render(<DonorList donations={donations} lastUpdatedAt={now} />);
    expect(screen.getByText("alice.eth")).toBeTruthy();
    expect(screen.queryByText("TokenBrice (founder subsidy)")).toBeNull();
  });

  it("shows empty state when no community donations exist", () => {
    render(<DonorList donations={[]} lastUpdatedAt={now} />);
    expect(screen.getByText(/No community donations yet/)).toBeTruthy();
  });

  it("counts the footer cap in donation rows, not supporters", () => {
    const donations: Donation[] = Array.from({ length: 25 }, (_, index) => ({
      chain: "ethereum",
      tx_hash: `0x${index.toString(16).padStart(4, "0")}`,
      block_timestamp: now - index * 60,
      from_address: `0x${index % 10}`,
      display: null,
      kind: "community",
      asset_symbol: "ETH",
      token_address: null,
      amount_decimal: 0.01,
      usd_at_receipt: 1,
      price_note: "coingecko-historical-2026-04-18",
    }));
    render(<DonorList donations={donations} lastUpdatedAt={now} />);
    expect(screen.getByText(/Showing most recent 20 of 25 donations\./)).toBeTruthy();
    expect(screen.queryByText(/Showing most recent 20 of 25 supporters/)).toBeNull();
  });
});
