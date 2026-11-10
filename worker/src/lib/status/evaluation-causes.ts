import type { StatusCause } from "@shared/types/status";
import { STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC } from "@shared/lib/status-thresholds";

export function expiringReviews(entries: readonly { id: string; expiresAt: number }[], nowSec: number) {
  return entries
    .map((entry) => ({ ...entry, remainingSec: entry.expiresAt - nowSec }))
    .filter((entry) => entry.remainingSec > 0 && entry.remainingSec <= STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC)
    .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
}

const OVERALL_CAUSE_PERSISTENCE_LIMIT = 12;
const DURABLE_ACTIVE_PRICE_CAUSE_CODES = new Set([
  "active_price_coverage_incomplete",
  "active_price_coverage_breadth_degraded",
  "active_price_coverage_unknown",
]);

export function synthesizeOverallCauses(availability: StatusCause[], dataQuality: StatusCause[]): StatusCause[] {
  const severityOrder = { critical: 0, warning: 1, info: 2 } as const;
  const ranked = [...availability, ...dataQuality].map((cause, sourceIndex) => ({ cause, sourceIndex }));
  const compareRanked = (a: (typeof ranked)[number], b: (typeof ranked)[number]) =>
    severityOrder[a.cause.severity] - severityOrder[b.cause.severity] || a.sourceIndex - b.sourceIndex;
  // Exact active-price coverage causes should survive the capped overall cause
  // list for operator diagnostics. Transient, non-alert-eligible misses are
  // info-only and must not occupy or displace a durable slot.
  const isDurableActivePrice = ({ cause }: (typeof ranked)[number]) =>
    DURABLE_ACTIVE_PRICE_CAUSE_CODES.has(cause.code) && cause.severity !== "info";
  const durableActivePrice = ranked.filter(isDurableActivePrice).sort(compareRanked);
  const remainingCapacity = Math.max(0, OVERALL_CAUSE_PERSISTENCE_LIMIT - durableActivePrice.length);
  const selected = [
    ...durableActivePrice.slice(0, OVERALL_CAUSE_PERSISTENCE_LIMIT),
    ...ranked
      .filter((entry) => !isDurableActivePrice(entry))
      .sort(compareRanked)
      .slice(0, remainingCapacity),
  ];

  return selected.sort(compareRanked).map(({ cause }) => cause);
}

