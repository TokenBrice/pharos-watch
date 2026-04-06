import { describe, expect, it } from "vitest";
import { NAV_GROUPS, PRIMARY_NAV_ITEMS } from "@/lib/nav-config";

describe("nav-config", () => {
  it("promotes dashboard and Pharos core features to the primary nav block in the intended order", () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/",
      "/stability-index",
      "/safety-scores",
      "/yield",
      "/telegram",
    ]);

    expect(PRIMARY_NAV_ITEMS.find((item) => item.href === "/telegram")?.label).toBe("Telegram");
  });

  it("keeps Digest in Analyze, renames the remaining nav sections, and excludes legacy Risk Lab grouping", () => {
    expect(NAV_GROUPS.some((group) => group.key === "risk-lab")).toBe(false);

    const trackGroup = NAV_GROUPS.find((group) => group.key === "data");
    const analyzeGroup = NAV_GROUPS.find((group) => group.key === "tools");
    const infoGroup = NAV_GROUPS.find((group) => group.key === "info");

    expect(trackGroup?.label).toBe("TRACK");
    expect(analyzeGroup?.label).toBe("Analyze");
    expect(analyzeGroup?.items.map((item) => item.href)).toEqual([
      "/portfolio",
      "/compare",
      "/dependency-map",
      "/digest",
    ]);

    expect(infoGroup?.label).toBe("Reference");
    expect(infoGroup?.items.some((item) => item.href === "/digest")).toBe(false);
  });
});
