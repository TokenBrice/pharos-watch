import { describe, expect, it } from "vitest";
import { classifyStaticRouteFile, summarizeStaticRouteFamilies } from "../lib/static-export-capacity.mts";
import { METHODOLOGY_HISTORY_ARCHIVES } from "@shared/lib/methodology-versions/archives";
import { CHANGELOG_MONTH_ARCHIVES } from "../../src/lib/changelog-history";

describe("static history capacity accounting", () => {
  it("counts complete archive identities, not one route per asset or methodology lane", () => {
    const files = [
      ...METHODOLOGY_HISTORY_ARCHIVES.flatMap((archive) => ["index.html", "index.txt", "index.md"].map((asset) => ({ rel: `out${archive.path}${asset}`, size: 10 }))),
      ...CHANGELOG_MONTH_ARCHIVES.flatMap((archive) => ["index.html", "index.txt", "index.md"].map((asset) => ({ rel: `out${archive.path}${asset}`, size: 10 }))),
    ];
    const groups = summarizeStaticRouteFamilies(files);
    expect(groups.find((group) => group.family === "methodology-archive")?.routeCount).toBe(METHODOLOGY_HISTORY_ARCHIVES.length);
    expect(groups.find((group) => group.family === "changelog-archive")?.routeCount).toBe(CHANGELOG_MONTH_ARCHIVES.length);
    expect(classifyStaticRouteFile("out/api/reference/index.html")).toEqual({ family: "api-reference", routeKey: "reference" });
  });

  it("uses major-version shards rather than route-per-release growth", () => {
    for (const archive of METHODOLOGY_HISTORY_ARCHIVES) {
      expect(archive.entries.length).toBeGreaterThan(0);
      expect(new Set(archive.entries.map((entry) => entry.version.split(".")[0])).size).toBe(1);
    }
  });
});
