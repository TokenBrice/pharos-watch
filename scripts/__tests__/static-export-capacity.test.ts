import { describe, expect, it } from "vitest";
import {
  classifyStaticRouteFile,
  projectStaticRouteCapacity,
  summarizeStaticRouteFamilies,
} from "../lib/static-export-capacity.mjs";

describe("static export capacity attribution", () => {
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
});
