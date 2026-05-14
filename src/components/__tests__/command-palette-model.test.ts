import { describe, expect, it } from "vitest";
import {
  buildCommandPaletteResultDescriptors,
  buildCommandPaletteActionDefinitions,
  fuzzyMatch,
  groupCommandPaletteResults,
  rankCommandPaletteResults,
} from "@/components/command-palette-model";

describe("command palette model", () => {
  it("matches direct substrings and word prefixes", () => {
    expect(fuzzyMatch("usd", "USD Coin")).toBe(true);
    expect(fuzzyMatch("co", "USD Coin")).toBe(true);
    expect(fuzzyMatch("xyz", "USD Coin")).toBe(false);
  });

  it("builds theme-dependent action descriptors without UI handlers", () => {
    expect(buildCommandPaletteActionDefinitions(true)[0]).toMatchObject({
      id: "action-theme",
      actionId: "theme",
      label: "Switch to light mode",
      icon: "theme-light",
    });
    expect(buildCommandPaletteActionDefinitions(false)[0]).toMatchObject({
      label: "Switch to dark mode",
      icon: "theme-dark",
    });
  });

  it("groups results in render order and skips empty sections", () => {
    const groups = groupCommandPaletteResults([
      { section: "Actions" as const, id: "action" },
      { section: "Stablecoins" as const, id: "coin" },
    ]);

    expect(groups).toEqual([
      { section: "Stablecoins", items: [{ section: "Stablecoins", id: "coin" }] },
      { section: "Actions", items: [{ section: "Actions", id: "action" }] },
    ]);
  });

  it("demotes frozen entries on tied scores", () => {
    const ranked = rankCommandPaletteResults([
      { id: "frozen-coin", score: 5, status: "frozen" as const },
      { id: "active-coin", score: 5, status: "active" as const },
    ]);

    expect(ranked.map((item) => item.id)).toEqual(["active-coin", "frozen-coin"]);
  });

  it("builds stablecoin, page, and action descriptors outside the component", () => {
    const stablecoinResults = buildCommandPaletteResultDescriptors({
      query: "usdt",
      history: [],
      isDark: false,
    });
    const pageAndActionResults = buildCommandPaletteResultDescriptors({
      query: "api",
      history: [],
      isDark: false,
    });

    expect(stablecoinResults.some((result) => result.section === "Stablecoins" && result.href?.includes("/stablecoin/"))).toBe(true);
    expect(pageAndActionResults.some((result) => result.section === "Pages" && result.href)).toBe(true);
    expect(pageAndActionResults.some((result) => result.section === "Actions" && result.actionId)).toBe(true);
  });
});
