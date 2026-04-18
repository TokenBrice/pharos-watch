import { describe, expect, it } from "vitest";
import {
  computeCostsTotal,
  groupCostsByCategory,
  summarizeDonations,
  monthKey,
} from "../helpers";
import type { CostLineItem, Donation } from "../types";

const COSTS: CostLineItem[] = [
  { label: "Ike", category: "team", usd_per_month: 1500 },
  { label: "Brice", category: "team", usd_per_month: 0, note: "Volunteer" },
  { label: "CoinGecko API", category: "infra", usd_per_month: 129 },
  { label: "Alchemy", category: "infra", usd_per_month: 40 },
  { label: "Cloudflare Workers", category: "infra", usd_per_month: 5 },
  { label: "Domain", category: "infra", usd_per_month: 2.85 },
];

const D = (ts: number, kind: Donation["kind"], usd: number, from = "0xa"): Donation => ({
  chain: "ethereum",
  tx_hash: `0x${ts}`,
  block_timestamp: ts,
  from_address: from,
  display: from,
  kind,
  asset_symbol: "ETH",
  amount_decimal: 0.1,
  usd_at_receipt: usd,
  price_note: "coingecko-spot-test",
});

describe("computeCostsTotal", () => {
  it("sums usd_per_month to two decimal places", () => {
    expect(computeCostsTotal(COSTS)).toBeCloseTo(1676.85, 2);
  });
});

describe("groupCostsByCategory", () => {
  it("returns team then infra, each with a subtotal", () => {
    const groups = groupCostsByCategory(COSTS);
    expect(groups).toEqual([
      { category: "team", items: [COSTS[0], COSTS[1]], subtotal: 1500 },
      { category: "infra", items: [COSTS[2], COSTS[3], COSTS[4], COSTS[5]], subtotal: 176.85 },
    ]);
  });

  it("omits categories with no items", () => {
    const infraOnly = COSTS.filter((c) => c.category === "infra");
    const groups = groupCostsByCategory(infraOnly);
    expect(groups.map((g) => g.category)).toEqual(["infra"]);
  });
});

describe("monthKey", () => {
  it("returns YYYY-MM in UTC", () => {
    const ts = Date.UTC(2026, 3, 18, 23, 59, 0) / 1000;
    expect(monthKey(ts)).toBe("2026-04");
  });
});

describe("summarizeDonations", () => {
  const apr = Date.UTC(2026, 3, 15) / 1000;
  const mar = Date.UTC(2026, 2, 15) / 1000;
  const feb = Date.UTC(2026, 1, 15) / 1000;

  it("splits community from founder and counts distinct community donors", () => {
    const rows: Donation[] = [
      D(apr, "community", 100, "0xa"),
      D(apr, "community", 50, "0xb"),
      D(apr, "founder", 1000, "0xf"),
      D(mar, "community", 200, "0xa"),
      D(feb, "pool", 25, "0xp"),
    ];
    const s = summarizeDonations(rows, apr);
    expect(s.currentMonthCommunityUsd).toBe(150);
    expect(s.currentMonthFounderUsd).toBe(1000);
    expect(s.lifetimeCommunityUsd).toBe(375); // 100 + 50 + 200 + 25
    expect(s.lifetimeFounderUsd).toBe(1000);
    // Distinct community senders across lifetime: 0xa, 0xb, 0xp
    expect(s.lifetimeCommunityDonorCount).toBe(3);
  });

  it("returns zeros when donations is empty", () => {
    const s = summarizeDonations([], apr);
    expect(s.lifetimeCommunityUsd).toBe(0);
    expect(s.lifetimeCommunityDonorCount).toBe(0);
    expect(s.currentMonthCommunityUsd).toBe(0);
    expect(s.currentMonthFounderUsd).toBe(0);
  });
});
