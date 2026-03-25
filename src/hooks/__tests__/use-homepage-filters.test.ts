import { describe, expect, it } from "vitest";
import { parseHomepageParams, FILTER_GROUPS } from "@/hooks/use-homepage-filters";

describe("FILTER_GROUPS", () => {
  it("defines groups with expected labels", () => {
    const labels = FILTER_GROUPS.map((g) => g.label);
    expect(labels).toContain("Peg");
    expect(labels).toContain("Type");
    expect(labels).toContain("Backing");
    expect(labels).toContain("Grade");
    expect(labels).toContain("Liquity Forks");
  });

  it("every group has at least one option", () => {
    for (const group of FILTER_GROUPS) {
      expect(group.options.length).toBeGreaterThan(0);
    }
  });
});

describe("parseHomepageParams", () => {
  it("returns empty selections and empty query for empty params", () => {
    const result = parseHomepageParams(new URLSearchParams(""));
    expect(result.groupSelections).toEqual({});
    expect(result.searchQuery).toBe("");
  });

  it("parses a valid peg filter", () => {
    const params = new URLSearchParams("peg=usd-peg");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBe("usd-peg");
  });

  it("parses a valid type filter", () => {
    const params = new URLSearchParams("type=decentralized");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Type"]).toBe("decentralized");
  });

  it("parses a valid backing filter", () => {
    const params = new URLSearchParams("backing=crypto-backed");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Backing"]).toBe("crypto-backed");
  });

  it("parses a valid grade filter", () => {
    const params = new URLSearchParams("grade=grade-a");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Grade"]).toBe("grade-a");
  });

  it("parses Liquity Forks filter using lowercase key", () => {
    const params = new URLSearchParams("liquity+forks=liquity-v2");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Liquity Forks"]).toBe("liquity-v2");
  });

  it("parses the search query q parameter", () => {
    const params = new URLSearchParams("q=usdc");
    const result = parseHomepageParams(params);
    expect(result.searchQuery).toBe("usdc");
  });

  it("ignores unknown filter values not in the group options", () => {
    const params = new URLSearchParams("peg=unknown-value");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBeUndefined();
  });

  it("ignores unknown filter group keys", () => {
    const params = new URLSearchParams("unknown=usd-peg");
    const result = parseHomepageParams(params);
    expect(Object.keys(result.groupSelections)).toHaveLength(0);
  });

  it("parses multiple filters simultaneously", () => {
    const params = new URLSearchParams("peg=gold-peg&type=centralized&backing=rwa-backed");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBe("gold-peg");
    expect(result.groupSelections["Type"]).toBe("centralized");
    expect(result.groupSelections["Backing"]).toBe("rwa-backed");
  });

  it("combines filters and search query", () => {
    const params = new URLSearchParams("peg=eur-peg&q=circle");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBe("eur-peg");
    expect(result.searchQuery).toBe("circle");
  });

  it("returns empty string for missing q param", () => {
    const params = new URLSearchParams("peg=usd-peg");
    const result = parseHomepageParams(params);
    expect(result.searchQuery).toBe("");
  });

  it("only allows one selection per group (last valid one in URL wins via URLSearchParams.get)", () => {
    // URLSearchParams.get returns the first occurrence
    const params = new URLSearchParams("peg=usd-peg&peg=eur-peg");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBe("usd-peg");
  });

  it("does not set selection for a group if value is missing from params", () => {
    const params = new URLSearchParams("type=centralized");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBeUndefined();
    expect(result.groupSelections["Backing"]).toBeUndefined();
    expect(result.groupSelections["Grade"]).toBeUndefined();
  });
});
