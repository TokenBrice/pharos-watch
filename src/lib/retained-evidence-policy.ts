import type { HomepageLaneMeta } from "@shared/types/homepage";

export const RETAINED_EVIDENCE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export function isRetainableHomepageLane(meta: HomepageLaneMeta, nowMs: number): boolean {
  return meta.updatedAt !== null && meta.updatedAt > 0
    && nowMs >= meta.updatedAt * 1000
    && nowMs - meta.updatedAt * 1000 <= RETAINED_EVIDENCE_MAX_AGE_MS;
}

