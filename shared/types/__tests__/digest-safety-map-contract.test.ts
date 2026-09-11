import { describe, expect, it } from "vitest";
import { COMPLETE_DIGEST_SAFETY_MAP as completeSafetyMap } from "@shared/test-utils/digest-safety-map";
import { parseDigestSafetyMapCapture } from "../digest-safety-map-contract";

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
