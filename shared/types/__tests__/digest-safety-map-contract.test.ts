import { describe, expect, it } from "vitest";
import { COMPLETE_DIGEST_SAFETY_MAP as completeSafetyMap } from "@shared/test-utils/digest-safety-map";
import {
  DigestSafetyMapCaptureSchema, parseDigestSafetyMapCapture, parseDigestSafetyMapManifest, parseDigestSafetyMapSummary,
} from "../digest-safety-map-contract";

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

const canonical = {
  ...completeSafetyMap,
  manifest: {
    ...completeSafetyMap.manifest, asOfSec: completeSafetyMap.manifest.mapSummary.asOfSec,
    renderedAtSec: completeSafetyMap.manifest.mapSummary.asOfSec, edition: "daily", bytes: { png: 10 },
  },
};

describe("Safety Map reader profiles", () => {
  it.each([
    ["canonical", {}, [true, true, true]],
    ["unknown capture key", { extra: true }, [false, true, true]],
    ["relative URL", { imageUrl: "/safety-scores/map.png?date=2026-08-30" }, [false, false, true]],
    ["missing age", { ageDays: undefined }, [false, false, true]],
    ["explicit null age", { ageDays: null }, [false, false, false]],
    ["inconsistent freshness", { ageDays: 1 }, [false, false, true]],
    ["legacy integer beyond safe range", { manifest: { ...canonical.manifest,
      mapSummary: { ...canonical.manifest.mapSummary, notRatedCount: 1e16 } } }, [false, true, true]],
  ])("preserves canonical-Zod/reader/archive admission for %s", (_name, patch, expected) => {
    const input = { ...canonical, ...patch };
    expect([
      DigestSafetyMapCaptureSchema.safeParse(input).success,
      parseDigestSafetyMapCapture(input, "canonical") !== null,
      parseDigestSafetyMapCapture(input, "archive-compatible") !== null,
    ]).toEqual(expected);
  });

  it("trims only the strict profile and selectively projects reader fields", () => {
    const summary = DigestSafetyMapCaptureSchema.parse(canonical).manifest.mapSummary;
    summary.methodologyVersion = " v9.4 ";
    summary.tiers[0].range = " 90-100 ";
    const input = { ...canonical, manifest: { ...canonical.manifest, mapSummary: summary } };
    expect(DigestSafetyMapCaptureSchema.parse(input).manifest.mapSummary.methodologyVersion).toBe("v9.4");
    expect(parseDigestSafetyMapCapture(input, "canonical")?.manifest.mapSummary.methodologyVersion).toBe(" v9.4 ");
    expect(parseDigestSafetyMapCapture(input, "archive-compatible")?.manifest.mapSummary).not.toHaveProperty("floorMcapByTier");
    expect(parseDigestSafetyMapCapture(input, "archive-compatible")?.manifest.mapSummary.tiers[0]).not.toHaveProperty("range");
  });

  it("keeps strict coverage structural while readers require reconciled coverage", () => {
    const summary = { ...canonical.manifest.mapSummary, supplyCoverage: {
      complete: true, observedCount: 9, unavailableCount: 0, unavailableById: {}, shareBasis: "known-mapped-supply",
    } };
    const input = { ...canonical, manifest: { ...canonical.manifest, mapSummary: summary } };
    expect(DigestSafetyMapCaptureSchema.safeParse(input).success).toBe(true);
    expect(parseDigestSafetyMapSummary(summary, "canonical")).toBeNull();
    expect(parseDigestSafetyMapSummary(summary, "archive-compatible")).toBeNull();
    expect(parseDigestSafetyMapSummary(canonical.manifest.mapSummary, "canonical")).not.toBeNull();
  });

  it.each([undefined, null, false, 1, "invalid", { coin: 1 }])("omits malformed reason records without throwing (%j)", (unavailableById) => {
    const mapSummary = { ...canonical.manifest.mapSummary, supplyCoverage: {
      complete: true, observedCount: 10, unavailableCount: 0, unavailableById, shareBasis: "known-mapped-supply",
    } };
    expect(parseDigestSafetyMapSummary(mapSummary, "canonical")).toBeNull();
    expect(parseDigestSafetyMapSummary(mapSummary, "archive-compatible")).toBeNull();
    expect(parseDigestSafetyMapManifest({ ...canonical.manifest, mapSummary }, "canonical")).not.toHaveProperty("mapSummary");
  });

  it.each([
    undefined, null, {}, { ...canonical.manifest.mapSummary, date: "2026-08-29" },
    { ...canonical.manifest.mapSummary, asOfSec: 1 },
  ])("omits invalid optional manifest summaries without rejecting the image (%j)", (mapSummary) => {
    const { mapSummary: _summary, ...manifest } = canonical.manifest;
    expect(parseDigestSafetyMapManifest({ ...manifest, mapSummary }, "canonical")).toEqual(manifest);
  });

  it("preserves loose finite manifest clocks but requires integer capture clocks", () => {
    const manifest = { ...canonical.manifest, asOfSec: -0.5, renderedAtSec: -1.5 };
    expect(parseDigestSafetyMapManifest(manifest, "canonical")).toMatchObject({ asOfSec: -0.5, renderedAtSec: -1.5 });
    expect(parseDigestSafetyMapCapture({ ...canonical, manifest }, "canonical")).toBeNull();
  });
});
