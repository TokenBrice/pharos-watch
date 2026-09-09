import { describe, expect, it } from "vitest";
import { parseDigestSafetyMapCapture } from "../digest-safety-map-contract";

const completeSafetyMap = {
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

const archiveSummary = {
  ...Object.fromEntries(Object.entries(completeSafetyMap.manifest.mapSummary).filter(([key]) => !["floorMcapByTier", "tiers"].includes(key))),
  tiers: completeSafetyMap.manifest.mapSummary.tiers.map(({ tier, count, mcapUsd, sharePct }) => ({ tier, count, mcapUsd, sharePct })),
};
const priorArchiveProjection = { ...completeSafetyMap, manifest: { date: "2026-08-30", mapSummary: archiveSummary } };

describe("parseDigestSafetyMapCapture", () => {
  it.each([
    ["canonical", completeSafetyMap, priorArchiveProjection],
    ["carried-forward", { ...completeSafetyMap, freshness: "carried-forward", ageDays: 2 }, { ...priorArchiveProjection, freshness: "carried-forward", ageDays: 2 }],
    ["legacy mapSummary", { ...completeSafetyMap, manifest: { date: "2026-08-30" }, mapSummary: completeSafetyMap.manifest.mapSummary }, priorArchiveProjection],
    ["legacy summary", { ...completeSafetyMap, manifest: { date: "2026-08-30" }, summary: completeSafetyMap.manifest.mapSummary }, priorArchiveProjection],
    ["legacy missing age", { ...completeSafetyMap, ageDays: undefined }, { ...priorArchiveProjection, ageDays: null }],
    ["legacy relative URL", { ...completeSafetyMap, imageUrl: "/safety-scores/map.png?date=2026-08-30" }, { ...priorArchiveProjection, imageUrl: "/safety-scores/map.png?date=2026-08-30" }],
    ["malformed", { ...completeSafetyMap, imageUrl: "/safety-scores/map.png" }, null],
  ])("normalizes %s captures into the archive-compatible shape", (_name, fixture, expected) => {
    expect(parseDigestSafetyMapCapture(fixture, "archive-compatible")).toEqual(expected);
  });
});
