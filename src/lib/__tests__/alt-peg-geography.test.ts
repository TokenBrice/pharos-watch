import { describe, expect, it } from "vitest";
import { PEG_COUNTRY_MAP, buildCountryColorMap } from "@/lib/alt-peg-geography";
import { buildAltPegLinkHubGroups } from "@/lib/alt-peg-market";

describe("PEG_COUNTRY_MAP", () => {
  it("covers every tracked fiat peg whose region is not 'Other'", () => {
    const fiatItems = buildAltPegLinkHubGroups()
      .find((group) => group.label === "Fiat")
      ?.items ?? [];
    const uncovered = fiatItems
      .filter((item) => item.region !== "Other")
      .filter((item) => !PEG_COUNTRY_MAP[item.peg])
      .map((item) => item.peg);
    expect(uncovered).toEqual([]);
  });

  it("uses unique ISO-A2 codes per peg", () => {
    const allCountries: string[] = [];
    for (const list of Object.values(PEG_COUNTRY_MAP)) {
      if (!list) continue;
      for (const iso of list) allCountries.push(iso);
    }
    const duplicates = allCountries.filter(
      (iso, index) => allCountries.indexOf(iso) !== index,
    );
    expect(duplicates).toEqual([]);
  });
});

describe("buildCountryColorMap", () => {
  it("propagates the item colorHex to every country the peg covers", () => {
    const items = [
      { peg: "EUR", colorHex: "#8b5cf6" },
      { peg: "JPY", colorHex: "#f43f5e" },
    ] as Parameters<typeof buildCountryColorMap>[0];

    const result = buildCountryColorMap(items);
    expect(result.get("DE")).toEqual({ peg: "EUR", colorHex: "#8b5cf6" });
    expect(result.get("FR")).toEqual({ peg: "EUR", colorHex: "#8b5cf6" });
    expect(result.get("JP")).toEqual({ peg: "JPY", colorHex: "#f43f5e" });
    expect(result.has("US")).toBe(false);
  });

  it("skips pegs with no country mapping", () => {
    const items = [
      { peg: "OTHER", colorHex: "#64748b" },
    ] as Parameters<typeof buildCountryColorMap>[0];
    expect(buildCountryColorMap(items).size).toBe(0);
  });
});
