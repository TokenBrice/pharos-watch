import { describe, expect, it } from "vitest";
import {
  classifyStaticRouteFile,
  countDocumentsReferencingChunks,
  projectStaticRouteCapacity,
  summarizeStaticRouteFamilies,
} from "../lib/static-export-capacity.mts";

describe("static export capacity attribution", () => {
  it("counts each document once when it references a tracked chunk", () => {
    expect(countDocumentsReferencingChunks(
      [
        '<script src="/_next/static/chunks/zod.js"></script>',
        '<script src="zod.js"></script><script src="other.js"></script>',
        '<script src="other.js"></script>',
      ],
      ["zod.js", "zod.js"],
    )).toBe(2);
    expect(countDocumentsReferencingChunks(["zod.js"], [])).toBe(0);
  });

  it("classifies per-coin and per-event route files without counting route roots", () => {
    expect(classifyStaticRouteFile("out/stablecoin/usdc-circle/index.html")).toEqual({
      family: "stablecoin-detail",
      routeKey: "usdc-circle",
    });
    expect(classifyStaticRouteFile("out/stablecoin/usdc-circle/yield/index.html")).toEqual({
      family: "stablecoin-yield",
      routeKey: "usdc-circle",
    });
    expect(classifyStaticRouteFile("out/depeg/usdc-2023-03-11/index.html")).toEqual({
      family: "depeg-event",
      routeKey: "usdc-2023-03-11",
    });
    expect(classifyStaticRouteFile("out/depeg/index.html")).toBeNull();
  });

  it("reports route, file, byte, and per-route growth costs", () => {
    const summary = summarizeStaticRouteFamilies([
      { rel: "out/stablecoin/a/index.html", size: 100 },
      { rel: "out/stablecoin/a/index.txt", size: 50 },
      { rel: "out/stablecoin/b/index.html", size: 200 },
      { rel: "out/stablecoin/a/yield/index.html", size: 300 },
    ]);

    expect(summary).toContainEqual({
      family: "stablecoin-detail",
      routeCount: 2,
      fileCount: 3,
      totalBytes: 350,
      averageFilesPerRoute: 1.5,
      averageBytesPerRoute: 175,
    });
  });

  it("projects hard-limit and 25-percent-headroom capacity per route family", () => {
    expect(projectStaticRouteCapacity({
      totalFiles: 12_500,
      fileLimit: 20_000,
      minimumHeadroomRatio: 0.25,
      averageFilesPerRoute: 10,
    })).toEqual({
      fileHeadroom: 7_500,
      headroomRatio: 0.375,
      targetMaximumFiles: 15_000,
      filesUntilHeadroomFloor: 2_500,
      routesUntilHardLimit: 750,
      routesUntilHeadroomFloor: 250,
    });
  });

  it.each([
    { totalFiles: 12, fileLimit: 21, averageFilesPerRoute: 2.5,
      expected: [9, 9 / 21, 15, 3, 3, 1] },
    { totalFiles: 17, fileLimit: 20, averageFilesPerRoute: 2.5,
      expected: [3, 0.15, 15, -2, 1, -1] },
    { totalFiles: 23, fileLimit: 20, averageFilesPerRoute: 2.5,
      expected: [0, 0, 15, -8, 0, -4] },
    { totalFiles: 12, fileLimit: 20, averageFilesPerRoute: 0,
      expected: [8, 0.4, 15, 3, 0, 0] },
    { totalFiles: 1, fileLimit: 0, averageFilesPerRoute: 2.5,
      expected: [0, 0, 0, -1, 0, -1] },
  ])("projects guarded fractional capacity for $totalFiles/$fileLimit files at $averageFilesPerRoute per route",
    ({ totalFiles, fileLimit, averageFilesPerRoute, expected }) => {
      const [fileHeadroom, headroomRatio, targetMaximumFiles, filesUntilHeadroomFloor,
        routesUntilHardLimit, routesUntilHeadroomFloor] = expected;
      expect(projectStaticRouteCapacity({
        totalFiles, fileLimit, averageFilesPerRoute, minimumHeadroomRatio: 0.25,
      })).toEqual({
        fileHeadroom, headroomRatio, targetMaximumFiles, filesUntilHeadroomFloor,
        routesUntilHardLimit, routesUntilHeadroomFloor,
      });
    });
});
