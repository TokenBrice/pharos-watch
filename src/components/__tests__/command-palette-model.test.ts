import { describe, expect, it } from "vitest";
import {
  buildCommandPaletteActionDefinitions,
  fuzzyMatch,
  groupCommandPaletteResults,
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
});
