import { describe, expect, it } from "vitest";
import { buildRouteBreadcrumb, routeLabelFor } from "../route-labels";

describe("route-labels", () => {
  it("serves shared labels used by route chrome", () => {
    expect(routeLabelFor("/")).toBe("Dashboard");
    expect(routeLabelFor("/yield")).toBe("Yield Intelligence");
    expect(routeLabelFor("/flows")).toBe("Mint/Burn Flows");
    expect(routeLabelFor("/portfolio")).toBe("Portfolio Audit");
    expect(routeLabelFor("/api")).toBe("API Access");
  });

  it("falls back through registered parents for nested routes", () => {
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
