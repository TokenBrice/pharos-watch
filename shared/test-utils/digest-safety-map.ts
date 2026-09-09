/** A complete, dated digest safety-map capture shared by the parser contract and the digest component tests. */
export const COMPLETE_DIGEST_SAFETY_MAP = {
  imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-08-30",
  freshness: "current",
  ageDays: 0,
  manifest: {
    date: "2026-08-30",
    mapSummary: {
      date: "2026-08-30",
      asOfSec: 1_788_000_000,
      methodologyVersion: "v9.4",
      gradedCount: 10,
      notRatedCount: 2,
      totalMcapUsd: 100_000_000_000,
      floorMcapByTier: { a: 1_000_000, other: 100_000 },
      tiers: [
        { tier: "A", range: "90–100", count: 2, mcapUsd: 70_000_000_000, sharePct: 70, leaders: [] },
        { tier: "B", range: "80–89", count: 2, mcapUsd: 15_000_000_000, sharePct: 15, leaders: [] },
        { tier: "C", range: "70–79", count: 2, mcapUsd: 8_000_000_000, sharePct: 8, leaders: [] },
        { tier: "D", range: "60–69", count: 2, mcapUsd: 5_000_000_000, sharePct: 5, leaders: [] },
        { tier: "F", range: "0–59", count: 2, mcapUsd: 2_000_000_000, sharePct: 2, leaders: [] },
      ],
    },
  },
} as const;
