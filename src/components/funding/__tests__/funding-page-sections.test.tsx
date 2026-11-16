// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CostBreakdown, DonorList, FundingHero } from "../funding-page-sections";
import type { CostLineItem, Donation } from "@shared/lib/funding/schema";
import type { DonationSummary, MonthlyFunding } from "@shared/lib/funding/helpers";

const NOW = Math.floor(Date.UTC(2026, 4, 10) / 1000);
const summary = (patch: Partial<DonationSummary> = {}): DonationSummary => ({
  currentMonthCommunityUsd: 300, currentMonthFounderUsd: 0, lifetimeCommunityUsd: 300, lifetimeFounderUsd: 0, lifetimeCommunityDonorCount: 2, ...patch,
});
const month = (monthKey: string, communityUsd: number, costUsd: number | null, isCurrent = false): MonthlyFunding => ({
  monthKey, label: new Date(`${monthKey}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }), communityUsd, costUsd, isCurrent,
});
const MONTHS = [month("2026-03", 80, null), month("2026-04", 427.5, 1710), month("2026-05", 300, 1540, true)];
const donation = (tx_hash: string, patch: Partial<Donation> = {}): Donation => ({
  chain: "ethereum", tx_hash, block_timestamp: NOW - 60, from_address: "0x1", display: tx_hash, kind: "community",
  asset_symbol: "ETH", token_address: null, amount_decimal: 0.1, usd_at_receipt: 300, price_note: "coingecko-historical-2026-05-10", ...patch,
});
const heroRows = () => within(screen.getByText("Who covers it").parentElement!);

describe("FundingHero", () => {
  it("measures coverage against each month's own cost and names who covers the rest", () => {
    render(<FundingHero summary={summary()} months={MONTHS} monthlyCostUsd={1540} founderUsd={8800} ledgerUpdatedAt={NOW} />);
    // 300 / 1540 this month; 427.5 / 1710 for April, never against today's cost.
    for (const text of ["19%", "Community, Apr 2026", "25%", "$8,800", "2 supporters"]) expect(heroRows().getByText(text)).toBeTruthy();
    expect(screen.getByText(/Funding never buys a score/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Support Pharos" }).getAttribute("href")).toBe("#how-to-support");
    // A closed month without a recorded cost stays unavailable in the figures table.
    expect(within(screen.getByRole("rowheader", { name: "Mar 2026" }).closest("tr")!).getAllByText("—")).toHaveLength(2);
    expect(screen.getByRole("rowheader", { name: "May 2026 (so far)" })).toBeTruthy();
  });

  it("keeps a small positive share visible and shows cold-start copy before any donation", () => {
    const { unmount } = render(<FundingHero summary={summary({ currentMonthCommunityUsd: 1.24 })} months={MONTHS} monthlyCostUsd={1709} founderUsd={0} ledgerUpdatedAt={NOW} />);
    expect(heroRows().getByText("<1%")).toBeTruthy();
    unmount();
    render(<FundingHero summary={summary({ currentMonthCommunityUsd: 0, lifetimeCommunityUsd: 0, lifetimeCommunityDonorCount: 0 })} months={[]} monthlyCostUsd={1540} founderUsd={0} ledgerUpdatedAt={NOW} />);
    for (const text of ["Tracking begins", "Be the first", /starts with the first community donation/]) expect(screen.getByText(text)).toBeTruthy();
  });
});

describe("CostBreakdown", () => {
  it("splits paid infrastructure by share, keeps $0 lines and one-time spend apart", () => {
    const items: CostLineItem[] = [
      { label: "Ike", category: "team", usd_per_month: 1500 },
      { label: "Brice", category: "team", usd_per_month: 0 },
      { label: "Small", category: "infra", usd_per_month: 0.4 },
      { label: "Big", category: "infra", usd_per_month: 99.6, mark: "/media/big.svg" },
      { label: "Sponsor", category: "infra", usd_per_month: 0, sponsor: { logo: "/media/s.svg", url: "https://s.example", blurb: "Thank you, Sponsor.", announcement: "/blog/s/" } },
    ];
    render(<CostBreakdown items={items} oneTime={[{ label: "Redesign", usd: 5800, paid_by: "founder" }]} lastReviewedAt={NOW} />);
    const share = screen.getByRole("img", { name: /infrastructure cost: Big 100%, Small <1%/ });
    // The sponsored line never reappears as a paid share.
    expect(share.getAttribute("aria-label")).not.toContain("Sponsor");
    for (const text of ["$100 / month", "$1,500 / month", "$5,800", /Costs reviewed/]) expect(screen.getByText(text)).toBeTruthy();
    const free = within(screen.getByText("Covered at no cost").closest("section")!);
    expect(free.getByText("Thank you, Sponsor.")).toBeTruthy();
    expect(free.getByText("Brice")).toBeTruthy();
  });
});

describe("DonorList", () => {
  it("hides founder rows and shows an empty state without a table", () => {
    const { unmount } = render(<DonorList donations={[donation("alice.eth"), donation("founder", { kind: "founder" })]} lastUpdatedAt={NOW} />);
    expect(screen.getByText("alice.eth")).toBeTruthy();
    expect(screen.queryByText("founder")).toBeNull();
    unmount();
    render(<DonorList donations={[]} lastUpdatedAt={NOW} />);
    expect(screen.getByText(/No community donations yet/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps cents on sub-dollar receipts and never renders an unpriced donation as zero", () => {
    render(
      <DonorList
        donations={[
          donation("0xcents", { usd_at_receipt: 0.06 }),
          donation("0xsubcent", { usd_at_receipt: 0.004 }),
          // An observed zero-dollar receipt is a value, not an unpriced row.
          donation("0xzerovalue", { usd_at_receipt: 0, price_note: "stablecoin-1-to-1" }),
          donation("0xunpriced", { usd_at_receipt: 0, price_note: "manual-token-not-priced" }),
        ]}
        lastUpdatedAt={NOW}
      />,
    );
    for (const text of ["$0.06", "<$0.01", "$0.00", "—"]) expect(screen.getAllByText(text)).toHaveLength(1);
    expect(screen.queryByText("$0")).toBeNull();
  });

  it("folds earlier rows and counts the footer in donation rows, not supporters", () => {
    render(<DonorList donations={Array.from({ length: 25 }, (_, i) => donation(`0x${i}`, { block_timestamp: NOW - i * 60, display: `donor-${i % 10}` }))} lastUpdatedAt={NOW} />);
    expect(screen.getByText("Show 15 earlier donations")).toBeTruthy();
    expect(screen.getByText("25 donations in the public ledger, newest first.")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(27);
  });
});
