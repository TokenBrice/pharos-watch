import { describe, expect, it } from "vitest";
import { parseHomepageParams, FILTER_GROUPS } from "@/hooks/use-homepage-filters";

describe("FILTER_GROUPS", () => {
  it("defines groups with expected labels", () => {
    const labels = FILTER_GROUPS.map((g) => g.label);
    expect(labels).toContain("Peg");
    expect(labels).toContain("Type");
    expect(labels).toContain("Backing");
    expect(labels).toContain("Grade");
    expect(labels).toContain("Infrastructure");
    expect(labels).toContain("Variant");
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

  it("parses the new aggregate fiat non-USD peg filter", () => {
    const params = new URLSearchParams("peg=fiat-non-usd-peg");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBe("fiat-non-usd-peg");
  });

  it("maps legacy gold and silver peg filters to commodities", () => {
    expect(parseHomepageParams(new URLSearchParams("peg=gold-peg")).groupSelections["Peg"]).toBe("commodity-peg");
    expect(parseHomepageParams(new URLSearchParams("peg=silver-peg")).groupSelections["Peg"]).toBe("commodity-peg");
  });

  it("maps legacy non-USD non-commodity peg filters to fiat non-USD", () => {
    expect(parseHomepageParams(new URLSearchParams("peg=eur-peg")).groupSelections["Peg"]).toBe("fiat-non-usd-peg");
    expect(parseHomepageParams(new URLSearchParams("peg=other-peg")).groupSelections["Peg"]).toBe("fiat-non-usd-peg");
    expect(parseHomepageParams(new URLSearchParams("peg=var-peg")).groupSelections["Peg"]).toBe("fiat-non-usd-peg");
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

  it("parses the consolidated >=C grade filter", () => {
    const params = new URLSearchParams("grade=grade-ge-c");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Grade"]).toBe("grade-ge-c");
  });

  it("maps legacy C-threshold grade filters to the consolidated >=C option", () => {
    expect(parseHomepageParams(new URLSearchParams("grade=grade-ge-c-plus")).groupSelections["Grade"]).toBe("grade-ge-c");
    expect(parseHomepageParams(new URLSearchParams("grade=grade-ge-c-minus")).groupSelections["Grade"]).toBe("grade-ge-c");
  });

  it("parses Infrastructure filter using lowercase key", () => {
    const params = new URLSearchParams("infrastructure=infrastructure-liquity-v2");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Infrastructure"]).toBe("infrastructure-liquity-v2");
  });

  it("parses Infrastructure filter for M0", () => {
    const params = new URLSearchParams("infrastructure=infrastructure-m0");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Infrastructure"]).toBe("infrastructure-m0");
  });

  it("parses the variant filter", () => {
    const params = new URLSearchParams("variant=variant-risk-absorption");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Variant"]).toBe("variant-risk-absorption");
  });

  it("parses the bond variant filter", () => {
    const params = new URLSearchParams("variant=variant-bond-maturity");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Variant"]).toBe("variant-bond-maturity");
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
    const params = new URLSearchParams("peg=commodity-peg&type=centralized&backing=rwa-backed");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBe("commodity-peg");
    expect(result.groupSelections["Type"]).toBe("centralized");
    expect(result.groupSelections["Backing"]).toBe("rwa-backed");
  });

  it("combines filters and search query", () => {
    const params = new URLSearchParams("peg=fiat-non-usd-peg&q=circle");
    const result = parseHomepageParams(params);
    expect(result.groupSelections["Peg"]).toBe("fiat-non-usd-peg");
    expect(result.searchQuery).toBe("circle");
  });

  it("returns empty string for missing q param", () => {
    const params = new URLSearchParams("peg=usd-peg");
    const result = parseHomepageParams(params);
    expect(result.searchQuery).toBe("");
  });

  it("only allows one selection per group (last valid one in URL wins via URLSearchParams.get)", () => {
    // URLSearchParams.get returns the first occurrence
    const params = new URLSearchParams("peg=usd-peg&peg=fiat-non-usd-peg");
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
