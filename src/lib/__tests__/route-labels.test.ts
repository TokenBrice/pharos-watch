import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "../nav-config";
import { buildRouteBreadcrumb, routeLabelFor } from "../route-labels";

describe("route-labels", () => {
  it("serves shared labels used by route chrome", () => {
    expect(routeLabelFor("/")).toBe("Dashboard");
    expect(routeLabelFor("/yield")).toBe("Yield Intelligence");
    expect(routeLabelFor("/flows")).toBe("Mint/Burn Flows");
    expect(routeLabelFor("/portfolio")).toBe("Portfolio Audit");
    expect(routeLabelFor("/api")).toBe("API Access");
  });

  it("derives visible route labels from navigation metadata", () => {
    const navLabels = new Map(NAV_ITEMS.filter((item) => !item.external).map((item) => [item.href, item.label]));

    expect(routeLabelFor("/stability-index")).toBe(navLabels.get("/stability-index/"));
    expect(routeLabelFor("/chains/")).toBe(navLabels.get("/chains/"));
  });

  it("falls back through registered parents for nested routes", () => {
    expect(routeLabelFor("/stablecoin/usdc-circle")).toBe("USDC");
    expect(routeLabelFor("/stablecoins/usd")).toBe("Usd");
    expect(routeLabelFor("/methodology/scoring-changelog")).toBe("Scoring Changelog");
  });

  it("keeps homepage breadcrumbs empty while nested breadcrumbs start at dashboard", () => {
    expect(buildRouteBreadcrumb("/")).toEqual([]);
    expect(buildRouteBreadcrumb("/yield/")).toEqual([
      { label: "Dashboard", href: "/" },
      { label: "Yield Intelligence", href: "/yield/" },
    ]);
  });
});
