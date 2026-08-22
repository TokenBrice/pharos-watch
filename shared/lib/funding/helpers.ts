import type { CostCategory, CostLineItem, Donation } from "./types";

const CATEGORY_ORDER: readonly CostCategory[] = ["team", "infra"];

function requireFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Funding ${field} must be finite`);
  return value;
}

export function computeCostsTotal(items: readonly CostLineItem[]): number {
  return items.reduce((sum, item) => sum + requireFinite(item.usd_per_month, "cost"), 0);
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
    const subtotal = computeCostsTotal(subset);
    return [{ category, items: subset, subtotal }];
  });
}

/** YYYY-MM in UTC. */
export function monthKey(timestampSec: number): string {
  requireFinite(timestampSec, "timestamp");
  const d = new Date(timestampSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Coverage percent label that surfaces small-but-positive amounts as "<1%". */
export function formatCoveragePct(communityUsd: number, targetUsd: number): string {
  if (targetUsd <= 0) return "—";
  const raw = (communityUsd / targetUsd) * 100;
  const rounded = Math.round(raw);
  if (raw > 0 && rounded === 0) return "<1%";
  return `${rounded}%`;
}

export interface MonthlyCommunityCoverage {
  monthKey: string;
  label: string;
  communityUsd: number;
}

/**
 * Per-month community totals for months strictly before `nowSec`'s month.
 * Months with no community donations are omitted. Sorted most-recent first.
 */
export function computeMonthlyHistory(
  donations: readonly Donation[],
  nowSec: number,
  maxMonths = 12,
): MonthlyCommunityCoverage[] {
  const currentMonth = monthKey(nowSec);
  const totals = new Map<string, number>();
  for (const d of donations) {
    requireFinite(d.block_timestamp, "timestamp");
    requireFinite(d.usd_at_receipt, "donation amount");
    if (d.kind === "founder") continue;
    const key = monthKey(d.block_timestamp);
    if (key === currentMonth) continue;
    totals.set(key, (totals.get(key) ?? 0) + d.usd_at_receipt);
  }
  return [...totals.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, maxMonths)
    .map(([key, communityUsd]) => {
      const [y, m] = key.split("-").map(Number);
      const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
      return { monthKey: key, label, communityUsd };
    });
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
    requireFinite(d.block_timestamp, "timestamp");
    requireFinite(d.usd_at_receipt, "donation amount");
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
