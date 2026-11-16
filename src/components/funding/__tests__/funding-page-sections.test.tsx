// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CostBreakdown, DonorList, FundingHero } from "../funding-page-sections";
import type { CostLineItem, Donation } from "@shared/lib/funding/schema";
import type { DonationSummary, MonthlyFunding } from "@shared/lib/funding/helpers";

function summary(overrides: Partial<DonationSummary> = {}): DonationSummary {
  return {
    currentMonthCommunityUsd: 300,
    currentMonthFounderUsd: 1000,
    lifetimeCommunityUsd: 300,
    lifetimeFounderUsd: 3000,
    lifetimeCommunityDonorCount: 2,
    ...overrides,
  };
}

const MONTHS: MonthlyFunding[] = [
  { monthKey: "2026-03", label: "Mar 2026", communityUsd: 80, costUsd: null, isCurrent: false },
  { monthKey: "2026-04", label: "Apr 2026", communityUsd: 427.5, costUsd: 1710, isCurrent: false },
  { monthKey: "2026-05", label: "May 2026", communityUsd: 300, costUsd: 1540, isCurrent: true },
];
const LEDGER_AT = Math.floor(Date.UTC(2026, 4, 10) / 1000);

describe("FundingHero", () => {
  it("measures coverage against each month's own cost and names who covers the rest", () => {
    render(<FundingHero summary={summary()} months={MONTHS} monthlyCostUsd={1540} founderUsd={8800} ledgerUpdatedAt={LEDGER_AT} />);
    // The beam, plus the current month's cost in the figures table.
    expect(screen.getAllByText("$1,540")).toHaveLength(2);
    // 300 / 1540 this month; 427.5 / 1710 for April, never against today's cost.
    const rows = within(screen.getByText("Who covers it").parentElement!);
    expect(rows.getByText("19%")).toBeTruthy();
    expect(rows.getByText("Community, Apr 2026")).toBeTruthy();
    expect(rows.getByText("25%")).toBeTruthy();
    expect(rows.getByText("$8,800")).toBeTruthy();
    expect(rows.getByText(/2 supporters/)).toBeTruthy();
    expect(screen.getByText(/Funding never buys a score/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Support Pharos" }).getAttribute("href")).toBe("#how-to-support");
    // A closed month without a recorded cost stays unavailable in the figures table.
    const march = screen.getByRole("rowheader", { name: "Mar 2026" }).closest("tr")!;
    expect(within(march).getAllByText("—")).toHaveLength(2);
    expect(screen.getByRole("rowheader", { name: "May 2026 (so far)" })).toBeTruthy();
  });

  it("renders <1% when monthly coverage is positive but rounds to zero", () => {
    render(
      <FundingHero
        summary={summary({ currentMonthCommunityUsd: 1.24, lifetimeCommunityDonorCount: 1 })}
        months={MONTHS}
        monthlyCostUsd={1709}
        founderUsd={0}
        ledgerUpdatedAt={LEDGER_AT}
      />,
    );
    expect(within(screen.getByText("Who covers it").parentElement!).getByText("<1%")).toBeTruthy();
  });

  it("shows cold-start copy and no chart before the first community donation", () => {
    render(
      <FundingHero
        summary={summary({ currentMonthCommunityUsd: 0, lifetimeCommunityUsd: 0, lifetimeCommunityDonorCount: 0 })}
        months={[]}
        monthlyCostUsd={1540}
        founderUsd={0}
        ledgerUpdatedAt={LEDGER_AT}
      />,
    );
    expect(screen.getByText("Tracking begins")).toBeTruthy();
    expect(screen.getByText("Be the first")).toBeTruthy();
    expect(screen.getByText(/starts with the first community donation/)).toBeTruthy();
  });
});

describe("CostBreakdown", () => {
  const ITEMS: CostLineItem[] = [
    { label: "Ike", category: "team", usd_per_month: 1500 },
    { label: "Brice", category: "team", usd_per_month: 0, note: "Uncompensated" },
    { label: "Small", category: "infra", usd_per_month: 0.4 },
    { label: "Big", category: "infra", usd_per_month: 99.6, mark: "/media/big.svg" },
    {
      label: "Sponsor",
      category: "infra",
      usd_per_month: 0,
      note: "RPC sponsored in kind",
      sponsor: { logo: "/media/sponsor.svg", url: "https://www.sponsor.example", blurb: "Thank you, Sponsor.", announcement: "/blog/sponsor/" },
    },
  ];

  it("splits paid infrastructure by share, keeps $0 lines and one-time spend apart", () => {
    render(<CostBreakdown items={ITEMS} oneTime={[{ label: "Redesign", usd: 5800, paid_by: "founder" }]} lastReviewedAt={LEDGER_AT} />);
    expect(screen.getByRole("img", { name: /infrastructure cost: Big 100%, Small <1%/ })).toBeTruthy();
    expect(screen.getByText("$100 / month")).toBeTruthy();
    expect(screen.getByText("$1,500 / month")).toBeTruthy();
    const free = screen.getByText("Covered at no cost").closest("section")!;
    expect(within(free).getByText("Thank you, Sponsor.")).toBeTruthy();
    expect(within(free).getByRole("link", { name: "Read the announcement" }).getAttribute("href")).toMatch(/^\/blog\/sponsor\/?$/);
    expect(within(free).getByText("Brice")).toBeTruthy();
    // The sponsored line never reappears as a paid share.
    expect(screen.getByRole("img", { name: /infrastructure cost/ }).getAttribute("aria-label")).not.toContain("Sponsor");
    expect(screen.getByText("$5,800")).toBeTruthy();
    expect(screen.getByText(/Costs reviewed/)).toBeTruthy();
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
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps cents on sub-dollar receipts and never renders an unpriced donation as zero", () => {
    const donation = (txHash: string, usdAtReceipt: number, priceNote: string): Donation => ({
      chain: "ethereum",
      tx_hash: txHash,
      block_timestamp: now - 60,
      from_address: "0x1",
      display: txHash,
      kind: "community",
      asset_symbol: "ETH",
      token_address: null,
      amount_decimal: 0.001,
      usd_at_receipt: usdAtReceipt,
      price_note: priceNote,
    });
    render(
      <DonorList
        donations={[
          donation("0xcents", 0.06, "coingecko-historical-2026-04-18"),
          donation("0xsubcent", 0.004, "coingecko-historical-2026-04-18"),
          // An observed zero-dollar receipt is a value, not an unpriced row.
          donation("0xzerovalue", 0, "stablecoin-1-to-1"),
          // The committed ledger's real unpriced marker.
          donation("0xunpriced", 0, "manual-token-not-priced"),
        ]}
        lastUpdatedAt={now}
      />,
    );
    expect(screen.getByText("$0.06")).toBeTruthy();
    expect(screen.getByText("<$0.01")).toBeTruthy();
    expect(screen.getAllByText("$0.00")).toHaveLength(1);
    expect(screen.getAllByText("—")).toHaveLength(1);
    expect(screen.queryByText("$0")).toBeNull();
  });

  it("folds earlier rows and counts the footer in donation rows, not supporters", () => {
    const donations: Donation[] = Array.from({ length: 25 }, (_, index) => ({
      chain: "ethereum",
      tx_hash: `0x${index.toString(16).padStart(4, "0")}`,
      block_timestamp: now - index * 60,
      from_address: `0x${index % 10}`,
      display: `donor-${index % 10}`,
      kind: "community",
      asset_symbol: "ETH",
      token_address: null,
      amount_decimal: 0.01,
      usd_at_receipt: 1,
      price_note: "coingecko-historical-2026-04-18",
    }));
    render(<DonorList donations={donations} lastUpdatedAt={now} />);
    // The fold and footer count donation rows from the full ledger, not supporters or visible rows.
    expect(screen.getByText("Show 15 earlier donations")).toBeTruthy();
    expect(screen.getByText("25 donations in the public ledger, newest first.")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(27);
  });
});
