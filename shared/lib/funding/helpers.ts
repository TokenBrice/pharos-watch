import type { CostCategory, CostLineItem, Donation } from "./types";

const CATEGORY_ORDER: readonly CostCategory[] = ["team", "infra"];

export function computeCostsTotal(items: readonly CostLineItem[]): number {
  return items.reduce((sum, item) => sum + item.usd_per_month, 0);
}

export interface CostCategoryGroup {
  category: CostCategory;
  items: CostLineItem[];
  subtotal: number;
}

export function groupCostsByCategory(items: readonly CostLineItem[]): CostCategoryGroup[] {
  return CATEGORY_ORDER.flatMap((category) => {
    const subset = items.filter((item) => item.category === category);
    if (subset.length === 0) return [];
    const subtotal = subset.reduce((sum, item) => sum + item.usd_per_month, 0);
    return [{ category, items: subset, subtotal }];
  });
}

/** YYYY-MM in UTC. */
export function monthKey(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface DonationSummary {
  currentMonthCommunityUsd: number;
  currentMonthFounderUsd: number;
  lifetimeCommunityUsd: number;
  lifetimeFounderUsd: number;
  lifetimeCommunityDonorCount: number;
}

/**
 * Split donations into community (kind !== "founder") and founder, computing
 * current-month and lifetime totals. `nowSec` defines "this month" so tests
 * and the page-render path agree.
 */
export function summarizeDonations(
  donations: readonly Donation[],
  nowSec: number,
): DonationSummary {
  const currentMonth = monthKey(nowSec);
  let currentMonthCommunityUsd = 0;
  let currentMonthFounderUsd = 0;
  let lifetimeCommunityUsd = 0;
  let lifetimeFounderUsd = 0;
  const communitySenders = new Set<string>();

  for (const d of donations) {
    const isFounder = d.kind === "founder";
    if (isFounder) {
      lifetimeFounderUsd += d.usd_at_receipt;
    } else {
      lifetimeCommunityUsd += d.usd_at_receipt;
      communitySenders.add(d.from_address);
    }
    if (monthKey(d.block_timestamp) === currentMonth) {
      if (isFounder) currentMonthFounderUsd += d.usd_at_receipt;
      else currentMonthCommunityUsd += d.usd_at_receipt;
    }
  }

  return {
    currentMonthCommunityUsd,
    currentMonthFounderUsd,
    lifetimeCommunityUsd,
    lifetimeFounderUsd,
    lifetimeCommunityDonorCount: communitySenders.size,
  };
}
