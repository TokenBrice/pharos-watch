import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";

/** Keep only explicitly active tracked IDs for write-side producers. */
export function includeActiveTrackedIds<T>(
  items: readonly T[],
  getId: (item: T) => string,
  activeIds: ReadonlySet<string> = WORKER_ACTIVE_IDS,
): T[] {
  return items.filter((item) => activeIds.has(getId(item)));
}
