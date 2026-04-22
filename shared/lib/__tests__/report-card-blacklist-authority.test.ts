import { describe, expect, it } from "vitest";
import { TRACKED_STABLECOINS } from "../stablecoins";
import { createBlacklistResolutionContext, resolveBlacklistStatus, resolveBlacklistStatuses } from "../report-cards";

function deterministicShuffle<T>(values: readonly T[]): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = (i * 17 + 11) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe("report-card blacklist authority", () => {
  it("keeps blacklist resolution stable across full-registry ordering changes", () => {
    const canonical = resolveBlacklistStatuses(TRACKED_STABLECOINS);
    const reversed = resolveBlacklistStatuses([...TRACKED_STABLECOINS].reverse());
    const shuffled = resolveBlacklistStatuses(deterministicShuffle(TRACKED_STABLECOINS));

    expect(reversed).toEqual(canonical);
    expect(shuffled).toEqual(canonical);
  });

  it("keeps batch and singleton resolution aligned when using the same resolved context", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);
    const blacklistableIds = new Set(
      [...resolved.entries()]
        .filter(([, status]) => status === true || status === "inherited")
        .map(([id]) => id),
    );
    const trackedMetaById = new Map(TRACKED_STABLECOINS.map((meta) => [meta.id, meta] as const));
    const context = createBlacklistResolutionContext(blacklistableIds, trackedMetaById);

    for (const meta of TRACKED_STABLECOINS) {
      expect(resolveBlacklistStatus(meta, { context, reserveSlices: meta.reserves })).toBe(resolved.get(meta.id));
    }
  });
});
