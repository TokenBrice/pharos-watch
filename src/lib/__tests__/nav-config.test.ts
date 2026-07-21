import { describe, expect, it } from "vitest";
import {
  COMPANION_NAV_ITEMS,
  DEFAULT_EXPANDED,
  NAV_GROUPS,
  NAV_ITEMS,
  UTILITY_NAV_ITEMS,
} from "@/lib/nav-config";

describe("nav-config", () => {
  it("uses the grouped IA as the canonical navigation model", () => {
    expect(NAV_GROUPS.map((group) => group.key)).toEqual([
      "overview",
      "markets",
      "risk",
      "analyze",
      "learn",
      "reference",
    ]);

    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      "Overview",
      "Markets",
      "Risk",
      "Analyze",
      "Learn",
      "Reference",
    ]);
  });

  it("groups overview, market, and risk routes by user intent", () => {
    const overviewGroup = NAV_GROUPS.find((group) => group.key === "overview");
    const marketsGroup = NAV_GROUPS.find((group) => group.key === "markets");
    const riskGroup = NAV_GROUPS.find((group) => group.key === "risk");

    expect(overviewGroup?.items.map((item) => ({ href: item.href, label: item.label }))).toEqual([
      { href: "/", label: "Dashboard" },
      { href: "/stability-index/", label: "Stability Index" },
      { href: "/timeline/", label: "Timeline" },
      { href: "/digest/", label: "Daily Digest" },
      { href: "/pharoswatchbot/", label: "Alert Bot" },
    ]);

    expect(marketsGroup?.items.map((item) => item.href)).toEqual([
      "/liquidity/",
      "/flows/",
      "/chains/",
      "/alt-pegs/",
      "/yield/",
      "/upcoming/",
    ]);

    expect(riskGroup?.items.map((item) => item.href)).toEqual([
      "/safety-scores/",
      "/depeg/",
      "/freezewatch/",
      "/compliance/",
      "/cemetery/",
    ]);
  });

  it("keeps Analyze tool-focused and separates Learn from Reference", () => {
    const analyzeGroup = NAV_GROUPS.find((group) => group.key === "analyze");
    const learnGroup = NAV_GROUPS.find((group) => group.key === "learn");
    const referenceGroup = NAV_GROUPS.find((group) => group.key === "reference");

    expect(analyzeGroup?.items.map((item) => item.href)).toEqual([
      "/screener/",
      "/dependency-map/",
      "/compare/",
      "/portfolio/",
    ]);

    expect(learnGroup?.items.map((item) => item.href)).toEqual([
      "/learn/",
      "/learn/mechanisms/",
      "/learn/case-studies/",
      "/learn/glossary/",
    ]);

    expect(referenceGroup?.items.map((item) => ({ href: item.href, label: item.label }))).toEqual([
      { href: "/methodology/", label: "Methodology" },
      { href: "/coverage/", label: "Coverage" },
      { href: "/about/", label: "About" },
      { href: "/funding/", label: "Funding" },
      { href: "/blog/", label: "Blog" },
    ]);

    expect(referenceGroup?.items.some((item) => item.href.startsWith("/learn/"))).toBe(false);
    expect(referenceGroup?.items.some((item) => item.href === "/api/")).toBe(false);
    expect(referenceGroup?.items.some((item) => item.href === "/changelog/")).toBe(false);
    expect(referenceGroup?.items.some((item) => item.href === "/status/")).toBe(false);
  });

  it("keeps overflow utility routes outside the grouped Reference menu", () => {
    expect(UTILITY_NAV_ITEMS.map((item) => ({ href: item.href, label: item.label }))).toEqual([
      { href: "/api/", label: "API Access" },
      { href: "/changelog/", label: "Changelog" },
      { href: "/status/", label: "System Status" },
    ]);

    const referenceGroup = NAV_GROUPS.find((group) => group.key === "reference");
    const referenceHrefs = new Set(referenceGroup?.items.map((item) => item.href));
    for (const item of UTILITY_NAV_ITEMS) {
      expect(referenceHrefs.has(item.href)).toBe(false);
      expect(NAV_ITEMS.some((navItem) => navItem.href === item.href)).toBe(true);
    }
  });

  it("sets practical default expansion for grouped mobile and legacy sidebar nav", () => {
    expect(DEFAULT_EXPANDED).toEqual({
      overview: true,
      markets: true,
      risk: true,
      analyze: false,
      learn: false,
      reference: false,
    });
  });

  it("exposes every grouped route to shared nav consumers without duplicates", () => {
    const groupedHrefs = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));
    const navHrefs = NAV_ITEMS.map((item) => item.href);

    for (const href of groupedHrefs) {
      expect(navHrefs).toContain(href);
    }

    expect(new Set(groupedHrefs).size).toBe(groupedHrefs.length);
    expect(new Set(navHrefs).size).toBe(navHrefs.length);
  });

  it("exposes PharosVille as an external companion entry, not a grouped route", () => {
    expect(COMPANION_NAV_ITEMS).toHaveLength(1);
    const ville = COMPANION_NAV_ITEMS[0];
    expect(ville.label).toBe("PharosVille");
    expect(ville.external).toBe(true);
    expect(ville.href.startsWith("https://")).toBe(true);
    expect(NAV_GROUPS.flatMap((group) => group.items).some((item) => item.label === "PharosVille")).toBe(false);
    expect(NAV_ITEMS.some((item) => item.label === "PharosVille")).toBe(true);
  });
});
