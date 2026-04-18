// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  FundingKpiRow,
  CostBreakdown,
  DonorList,
} from "../funding-page-sections";
import type { CostLineItem, Donation } from "@shared/lib/funding/types";

afterEach(cleanup);

const COSTS: CostLineItem[] = [
  { label: "Ike", category: "team", usd_per_month: 1500 },
  { label: "Alchemy", category: "infra", usd_per_month: 40 },
];

describe("FundingKpiRow", () => {
  it("renders numeric KPIs when there is community history", () => {
    render(
      <FundingKpiRow
        summary={{
          currentMonthCommunityUsd: 300,
          currentMonthFounderUsd: 1000,
          lifetimeCommunityUsd: 300,
          lifetimeFounderUsd: 3000,
          lifetimeCommunityDonorCount: 2,
        }}
        monthlyTargetUsd={1540}
      />,
    );
    expect(screen.getByText("This month coverage")).toBeTruthy();
    // 300 / 1540 ≈ 19%
    expect(screen.getByText("19%")).toBeTruthy();
    expect(screen.getByText("Community support")).toBeTruthy();
    expect(screen.getByText(/from 2 supporters/)).toBeTruthy();
  });

  it("shows cold-start copy when lifetime community is zero", () => {
    render(
      <FundingKpiRow
        summary={{
          currentMonthCommunityUsd: 0,
          currentMonthFounderUsd: 0,
          lifetimeCommunityUsd: 0,
          lifetimeFounderUsd: 0,
          lifetimeCommunityDonorCount: 0,
        }}
        monthlyTargetUsd={1540}
      />,
    );
    expect(screen.getByText("Tracking begins")).toBeTruthy();
    expect(screen.getByText("Be the first")).toBeTruthy();
  });
});

describe("CostBreakdown", () => {
  it("renders team and infra groups and total", () => {
    render(
      <CostBreakdown
        items={COSTS}
        currentCommunityUsd={300}
        currentFounderUsd={1240}
        lifetimeFounderUsd={3000}
        lastReviewedAt={1744934400}
      />,
    );
    expect(screen.getByText("Team")).toBeTruthy();
    expect(screen.getByText("Infrastructure")).toBeTruthy();
    expect(screen.getByText("Ike")).toBeTruthy();
    expect(screen.getByText(/1,540/)).toBeTruthy(); // total
    // Footer exposes community + founder split explicitly
    expect(screen.getByText(/This month: \$300 community/)).toBeTruthy();
    expect(screen.getByText(/Lifetime founder subsidy: \$3,000/)).toBeTruthy();
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
});
