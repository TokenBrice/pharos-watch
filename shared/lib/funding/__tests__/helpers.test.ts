import { describe, expect, it } from "vitest";
import {
  computeCostsTotal,
  buildMonthlyFunding,
  summarizeDonations,
} from "../helpers";
import type { CostLineItem, Donation } from "../schema";
import { makeDonation } from "./funding.test-support";

const COSTS: CostLineItem[] = [
  { label: "Ike", category: "team", usd_per_month: 1500 },
  { label: "Brice", category: "team", usd_per_month: 0, note: "Volunteer" },
  { label: "CoinGecko API", category: "infra", usd_per_month: 129 },
  { label: "Alchemy", category: "infra", usd_per_month: 40 },
  { label: "Cloudflare Workers", category: "infra", usd_per_month: 5 },
  { label: "Domain", category: "infra", usd_per_month: 2.85 },
];

const D = (ts: number, kind: Donation["kind"], usd: number, from = "a"): Donation => makeDonation({
  tx_hash: `0x${ts}`,
  block_timestamp: ts,
  from_address: `0x${from.padStart(40, "0")}`,
  display: from,
  kind,
  usd_at_receipt: usd,
});

describe("computeCostsTotal", () => {
  it("sums usd_per_month to two decimal places", () => {
    expect(computeCostsTotal(COSTS)).toBeCloseTo(1676.85, 2);
  });

  it("rejects non-finite cost values before summing", () => {
    expect(() => computeCostsTotal([{ label: "bad", category: "team", usd_per_month: Number.NaN }])).toThrow();
  });
});

describe("summarizeDonations", () => {
  const apr = Date.UTC(2026, 3, 15) / 1000;
  const mar = Date.UTC(2026, 2, 15) / 1000;
  const feb = Date.UTC(2026, 1, 15) / 1000;

  it("splits community from founder and counts distinct community donors", () => {
    const rows: Donation[] = [
      D(apr, "community", 100, "a"),
      D(apr, "community", 50, "b"),
      D(apr, "founder", 1000, "f"),
      D(mar, "community", 200, "a"),
      D(feb, "pool", 25, "d"),
    ];
    const s = summarizeDonations(rows, apr);
    expect(s.currentMonthCommunityUsd).toBe(150);
    expect(s.currentMonthFounderUsd).toBe(1000);
    expect(s.lifetimeCommunityUsd).toBe(375); // 100 + 50 + 200 + 25
    expect(s.lifetimeFounderUsd).toBe(1000);
    // Distinct community senders across lifetime: a, b, d.
    expect(s.lifetimeCommunityDonorCount).toBe(3);
  });

  it("returns zeros when donations is empty", () => {
    const s = summarizeDonations([], apr);
    expect(s.lifetimeCommunityUsd).toBe(0);
    expect(s.lifetimeCommunityDonorCount).toBe(0);
    expect(s.currentMonthCommunityUsd).toBe(0);
    expect(s.currentMonthFounderUsd).toBe(0);
  });

  it("rejects non-finite donation amounts before summing", () => {
    expect(() => summarizeDonations([D(apr, "community", Number.NaN)], apr)).toThrow();
  });
});

describe("buildMonthlyFunding", () => {
  const may = Date.UTC(2026, 4, 3) / 1000;
  const apr = Date.UTC(2026, 3, 15) / 1000;
  const feb = Date.UTC(2026, 1, 15) / 1000;
  const costs = { items: COSTS, monthly_totals: [{ month: "2026-02", usd: 1709 }, { month: "2026-04", usd: 1709 }] };

  it("lists every month oldest first, with founders excluded and empty months as $0", () => {
    const rows: Donation[] = [
      D(may, "community", 5, "a"),
      D(apr, "community", 100, "a"),
      D(apr, "community", 50, "b"),
      D(apr, "founder", 999, "f"),
      D(feb, "community", 25, "c"),
    ];
    expect(buildMonthlyFunding(rows, costs, may).map(({ monthKey, communityUsd }) => [monthKey, communityUsd])).toEqual([
      ["2026-02", 25], ["2026-03", 0], ["2026-04", 150], ["2026-05", 5],
    ]);
  });

  it("measures each month against its own recorded cost and never backfills today's", () => {
    const months = buildMonthlyFunding([D(feb, "community", 25, "c")], costs, may);
    expect(months.map(({ monthKey, costUsd, isCurrent }) => [monthKey, costUsd, isCurrent])).toEqual([
      ["2026-02", 1709, false],
      // No recorded total: unavailable, not the current cost.
      ["2026-03", null, false],
      ["2026-04", 1709, false],
      // The current month uses today's line items.
      ["2026-05", computeCostsTotal(COSTS), true],
    ]);
    expect(months[0].label).toBe("Feb 2026");
  });

  it("caps the window and returns nothing before the first community donation", () => {
    expect(buildMonthlyFunding([D(feb, "community", 25, "c")], costs, may, 2).map((m) => m.monthKey)).toEqual(["2026-04", "2026-05"]);
    expect(buildMonthlyFunding([D(apr, "founder", 999, "f")], costs, may)).toEqual([]);
  });
});
