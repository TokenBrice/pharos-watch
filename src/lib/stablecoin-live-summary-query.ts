import type { ApiMeta } from "@/lib/api";

type SummaryEnvelope<T> = { data: T; meta: ApiMeta | null };

/** A cache hit from an older producer must not roll a newer build/live generation back. */
export function reconcileStablecoinLiveSummary<T>(
  previous: SummaryEnvelope<T> | undefined,
  incoming: SummaryEnvelope<T>,
): SummaryEnvelope<T> {
  const previousAt = previous?.meta?.updatedAt;
  const incomingAt = incoming.meta?.updatedAt;
  if (previous?.meta && previousAt != null && (incomingAt == null || incomingAt < previousAt)) {
    const retainedMeta = {
      ...previous.meta,
      status: "stale" as const,
      reason: "older-live-generation-retained",
      ...(incoming.meta?.warning ? { warning: incoming.meta.warning } : {}),
    };
    return { data: previous.data, meta: retainedMeta };
  }
  // This is the oldest contributing clock, not an immutable payload identity:
  // canonical supply/price and provider history can change independently.
  // In particular, an equal-clock quarantine must replace saved positive supply.
  return incoming;
}
