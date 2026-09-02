// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  FundingKpiRow,
  CostBreakdown,
  DonorList,
  FundingFaq,
  SupportCtas,
  YearEndHorizon,
} from "../funding-page-sections";
import type { CostLineItem, Donation } from "@shared/lib/funding/schema";


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
        summary={{
          currentMonthCommunityUsd: 1.24,
          currentMonthFounderUsd: 0,
          lifetimeCommunityUsd: 100,
          lifetimeFounderUsd: 0,
          lifetimeCommunityDonorCount: 1,
        }}
        monthlyTargetUsd={1709}
      />,
    );
    expect(screen.getByText("<1%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toContain("<1%");
  });

  it("renders previous-month funding and coverage in a comparison table", () => {
    render(
      <FundingKpiRow
        summary={{
          currentMonthCommunityUsd: 1,
          currentMonthFounderUsd: 0,
          lifetimeCommunityUsd: 691,
          lifetimeFounderUsd: 0,
          lifetimeCommunityDonorCount: 18,
        }}
        monthlyTargetUsd={1709}
        monthlyHistory={[
          { monthKey: "2026-05", label: "May 2026", communityUsd: 866 },
          { monthKey: "2026-04", label: "Apr 2026", communityUsd: 690 },
        ]}
      />,
    );
    expect(screen.getByText("Previous months")).toBeTruthy();
    expect(screen.getByText(/Coverage against the \$1,709 monthly goal/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Previous monthly funding coverage" });
    expect(within(table).getByRole("columnheader", { name: "Month" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Community" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Coverage" })).toBeTruthy();
    const mayRow = within(table).getByRole("row", { name: /May 2026/ });
    expect(within(mayRow).getByText("$866")).toBeTruthy();
    expect(within(mayRow).getByText("51%")).toBeTruthy();
    const aprilRow = within(table).getByRole("row", { name: /Apr 2026/ });
    expect(within(aprilRow).getByText("$690")).toBeTruthy();
    // 690 / 1709 ≈ 40.4% → "40%"
    expect(within(aprilRow).getByText("40%")).toBeTruthy();
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
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toContain("Tracking begins");
  });
});

describe("CostBreakdown", () => {
  it("renders team and infra groups, total, and derived open funding gap", () => {
    render(<CostBreakdown items={COSTS} currentCommunityUsd={300} lastReviewedAt={1744934400} />);
    expect(screen.getByText("Team")).toBeTruthy();
    expect(screen.getByText("Infrastructure")).toBeTruthy();
    expect(screen.getByText("Ike")).toBeTruthy();
    expect(screen.getByText(/1,540/)).toBeTruthy(); // total
    // Open gap is derived: max(0, total - community) = 1540 - 300 = 1240
    expect(screen.getByText(/This month: \$300 community · \$1,240 still open/)).toBeTruthy();
    expect(screen.getByText(/TokenBrice also sponsored \$5,800 in one-time design expenses/)).toBeTruthy();
    expect(screen.getByText(/not included in the monthly total/)).toBeTruthy();
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

describe("SupportCtas", () => {
  it("highlights recurring Giveth support as the long-term path and notes the OP/Base constraint", () => {
    render(<SupportCtas />);
    expect(screen.getByText("Recurring via Giveth")).toBeTruthy();
    expect(screen.getByText("Set up Giveth support")).toBeTruthy();
    expect(screen.getByText(/Recurring streams run on Optimism or Base only/)).toBeTruthy();
    expect(screen.getByText(/recurring Giveth stream on Optimism or Base/)).toBeTruthy();
  });
});

describe("YearEndHorizon", () => {
  it("commits to a free dashboard and names the two sustainability streams", () => {
    render(<YearEndHorizon />);
    expect(screen.getByText(/dashboard stays free for everyone, forever/)).toBeTruthy();
    expect(screen.getByText(/paid API access for institutional users/)).toBeTruthy();
    expect(screen.getByText(/self-sustaining by Q4 2026/)).toBeTruthy();

    const shareLink = screen.getByRole("link", { name: "sharing Pharos" });
    const href = shareLink.getAttribute("href") ?? "";
    expect(decodeURIComponent(href)).toContain("Stablecoin risk data should be public infrastructure");
    expect(decodeURIComponent(href)).toContain("Help keep it open: https://pharos.watch");
  });
});

describe("FundingFaq", () => {
  it("focuses on impact and does not mention a nonexistent on-chain ledger", () => {
    render(<FundingFaq />);
    expect(screen.getByText("Why does Pharos ask for support?")).toBeTruthy();
    expect(screen.getByText("Why recurring Giveth donations?")).toBeTruthy();
    expect(screen.getByText("What does support make possible?")).toBeTruthy();
    expect(screen.getByText(/More stablecoins covered/)).toBeTruthy();
    expect(screen.queryByText(/on-chain ledger/i)).toBeNull();
  });
});
