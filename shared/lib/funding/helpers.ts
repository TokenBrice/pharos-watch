import type { CostLineItem, CostsFile, Donation } from "./schema";

function requireFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`Funding ${field} must be finite`);
  return value;
}

/**
 * The ledger's provenance marker for a receipt the funding-update workflow
 * could not price; its `usd_at_receipt` is a placeholder, not a value.
 */
const UNPRICED_DONATION_PRICE_NOTE = "manual-token-not-priced";

export function isUnpricedDonation(priceNote: string): boolean {
  return priceNote === UNPRICED_DONATION_PRICE_NOTE;
}

export function computeCostsTotal(items: readonly CostLineItem[]): number {
  return items.reduce((sum, item) => sum + requireFinite(item.usd_per_month, "cost"), 0);
}

/**
 * Whether a ledger row counts as a donation. Founder transfers and
 * partner-key revenue are ledger receipts, never community support.
 */
export function isCommunityDonation(donation: Pick<Donation, "kind">): boolean {
  return donation.kind !== "founder" && donation.kind !== "revenue";
}

/** YYYY-MM in UTC. */
function monthKey(timestampSec: number): string {
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

export interface MonthlyFunding {
  monthKey: string;
  /** "Oct 2026". */
  label: string;
  communityUsd: number;
  /**
   * Monthly cost published for that month: the recorded `monthly_totals` row
   * for a closed month, today's line items for the current month. `null` when
   * a closed month has no recorded total: unavailable, never today's cost.
   */
  costUsd: number | null;
  isCurrent: boolean;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Community donations per UTC month, oldest first, from the first community
 * donation (or at most `maxMonths` back) through `nowSec`'s month. A month
 * with no donations shows as $0 rather than disappearing; founder and revenue
 * rows never count as community.
 */
export function buildMonthlyFunding(
  donations: readonly Donation[],
  costs: Pick<CostsFile, "items" | "monthly_totals">,
  nowSec: number,
  maxMonths = 12,
): MonthlyFunding[] {
  const currentMonth = monthKey(nowSec);
  const totals = new Map<string, number>();
  let earliest: string | null = null;
  for (const d of donations) {
    requireFinite(d.usd_at_receipt, "donation amount");
    if (!isCommunityDonation(d)) continue;
    const key = monthKey(d.block_timestamp);
    if (key > currentMonth) continue;
    if (earliest === null || key < earliest) earliest = key;
    totals.set(key, (totals.get(key) ?? 0) + d.usd_at_receipt);
  }
  if (earliest === null) return [];

  const recorded = new Map(costs.monthly_totals.map((row) => [row.month, row.usd]));
  const currentCost = computeCostsTotal(costs.items);
  const months: MonthlyFunding[] = [];
  let [y, m] = currentMonth.split("-").map(Number);
  while (months.length < maxMonths) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key < earliest) break;
    const isCurrent = key === currentMonth;
    months.push({
      monthKey: key,
      label: monthLabel(key),
      communityUsd: totals.get(key) ?? 0,
      costUsd: isCurrent ? currentCost : (recorded.get(key) ?? null),
      isCurrent,
    });
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  return months.reverse();
}

export interface DonationSummary {
  currentMonthCommunityUsd: number;
  currentMonthFounderUsd: number;
  lifetimeCommunityUsd: number;
  lifetimeFounderUsd: number;
  lifetimeCommunityDonorCount: number;
  /** Partner-key revenue, kept apart from every donation figure above. */
  lifetimeRevenueUsd: number;
}

/**
 * Split ledger rows into community (kind !== "founder" and !== "revenue"),
 * founder and partner-key revenue, computing current-month and lifetime
 * totals. `nowSec` defines "this month" so tests and the page-render path
 * agree.
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
  let lifetimeRevenueUsd = 0;
  const communitySenders = new Set<string>();

  for (const d of donations) {
    requireFinite(d.block_timestamp, "timestamp");
    requireFinite(d.usd_at_receipt, "donation amount");
    const isFounder = d.kind === "founder";
    const isRevenue = d.kind === "revenue";
    if (isFounder) {
      lifetimeFounderUsd += d.usd_at_receipt;
    } else if (isRevenue) {
      lifetimeRevenueUsd += d.usd_at_receipt;
    } else {
      lifetimeCommunityUsd += d.usd_at_receipt;
      communitySenders.add(d.from_address);
    }
    if (monthKey(d.block_timestamp) === currentMonth) {
      if (isFounder) currentMonthFounderUsd += d.usd_at_receipt;
      else if (!isRevenue) currentMonthCommunityUsd += d.usd_at_receipt;
    }
  }

  return {
    currentMonthCommunityUsd,
    currentMonthFounderUsd,
    lifetimeCommunityUsd,
    lifetimeFounderUsd,
    lifetimeCommunityDonorCount: communitySenders.size,
    lifetimeRevenueUsd,
  };
}
