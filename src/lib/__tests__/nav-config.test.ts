import { describe, expect, it } from "vitest";
import {
  COMPANION_NAV_ITEMS,
  CORE_NAV_ITEMS,
  getSidebarNavForPath,
  isCoreNavPath,
  NAV_GROUPS,
  NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
} from "@/lib/nav-config";

describe("nav-config", () => {
  it("promotes dashboard and Pharos core features to the primary nav block in the intended order", () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/",
      "/safety-scores/",
      "/depeg/",
      "/freezewatch/",
      "/alt-pegs/",
      "/yield/",
      "/stability-index/",
      "/pharoswatchbot/",
    ]);
    expect(PRIMARY_NAV_ITEMS.find((item) => item.href === "/alt-pegs/")?.label).toBe("Alt-Pegs");
    expect(PRIMARY_NAV_ITEMS.find((item) => item.href === "/depeg/")?.label).toBe("Depeg/DDR");
    expect(PRIMARY_NAV_ITEMS.at(-1)).toMatchObject({ href: "/pharoswatchbot/", label: "PharosWatchBot" });

    // Depeg/DDR stays in the main route run so active incidents are visible. Digest and Status stay in MONITOR.
    const dataGroup = NAV_GROUPS.find((group) => group.key === "data");
    const monitorGroup = NAV_GROUPS.find((group) => group.key === "monitor");
    expect(dataGroup?.items.some((item) => item.href === "/depeg/")).toBe(false);
    expect(dataGroup?.items.some((item) => item.href === "/freezewatch/")).toBe(false);
    expect(dataGroup?.items.some((item) => item.href === "/pharoswatchbot/")).toBe(false);
    expect(monitorGroup?.items.some((item) => item.href === "/pharoswatchbot/")).toBe(false);
  });

  it("orders the sidebar groups and routes as requested while excluding legacy Risk Lab grouping", () => {
    expect(NAV_GROUPS.some((group) => group.key === "risk-lab")).toBe(false);
    expect(NAV_GROUPS.map((group) => group.key)).toEqual(["data", "tools", "monitor", "learn", "info"]);

    const trackGroup = NAV_GROUPS.find((group) => group.key === "data");
    const analyzeGroup = NAV_GROUPS.find((group) => group.key === "tools");
    const monitorGroup = NAV_GROUPS.find((group) => group.key === "monitor");
    const infoGroup = NAV_GROUPS.find((group) => group.key === "info");

    expect(trackGroup?.label).toBe("TRACK");
    expect(trackGroup?.items.map((item) => item.label)).toEqual([
      "Liquidity",
      "Mint/Burn Flows",
      "Chains",
      "Cemetery",
    ]);

    expect(analyzeGroup?.label).toBe("ANALYZE");
    expect(analyzeGroup?.items.map((item) => item.href)).toEqual([
      "/screener/",
      "/dependency-map/",
      "/portfolio/",
      "/compare/",
    ]);

    expect(monitorGroup?.label).toBe("MONITOR");
    expect(monitorGroup?.items.map((item) => ({ href: item.href, label: item.label }))).toEqual([
      { href: "/timeline/", label: "Timeline" },
      { href: "/compliance/", label: "Compliance" },
      { href: "/upcoming/", label: "Upcoming" },
      { href: "/digest/", label: "Digest" },
      { href: "/status/", label: "Pharos Status" },
    ]);

    expect(infoGroup?.label).toBe("REFERENCE");
    expect(infoGroup?.items.some((item) => item.href === "/digest/")).toBe(false);
    expect(infoGroup?.items.some((item) => item.href === "/status/")).toBe(false);
    expect(infoGroup?.items.map((item) => item.href)).toEqual([
      "/about/",
      "/funding/",
      "/methodology/",
      "/coverage/",
      "/api/",
      "/changelog/",
    ]);
    expect(infoGroup?.items.find((item) => item.href === "/api/")?.label).toBe("API Access");

    // LEARN groups the educational surfaces (mechanisms moved here from REFERENCE).
    const learnGroup = NAV_GROUPS.find((group) => group.key === "learn");
    expect(learnGroup?.label).toBe("LEARN");
    expect(learnGroup?.items.map((item) => item.href)).toEqual([
      "/learn/",
      "/learn/mechanisms/",
      "/learn/case-studies/",
      "/learn/glossary/",
    ]);
  });

  it("mirrors the primary order on the core rail and suppresses duplicate core links beside it", () => {
    // The rail and the sidebar primary block are the same set in the same
    // order; two orderings of the same eight pages read as different menus.
    expect(CORE_NAV_ITEMS.map((item) => ({ href: item.href, label: item.label }))).toEqual(
      PRIMARY_NAV_ITEMS.map((item) => ({ href: item.href, label: item.label })),
    );

    expect(isCoreNavPath("/timeline/")).toBe(false);
    expect(isCoreNavPath("/learn/")).toBe(false);
    expect(isCoreNavPath("/status/")).toBe(false);
    expect(isCoreNavPath("/learn/mechanisms/")).toBe(false);

    // On a core page the horizontal rail lists the full core set, so the
    // sidebar keeps Dashboard as its only core entry; the groups stay intact.
    const corePageNav = getSidebarNavForPath("/yield/");
    expect(corePageNav.primaryItems.map((item) => item.href)).toEqual(["/"]);
    expect(corePageNav.groups).toBe(NAV_GROUPS);
    expect(corePageNav.groups.flatMap((group) => group.items).some((item) => item.href === "/timeline/")).toBe(true);
    expect(corePageNav.groups.flatMap((group) => group.items).some((item) => item.href === "/learn/mechanisms/")).toBe(true);
    expect(corePageNav.groups.flatMap((group) => group.items).some((item) => item.href === "/status/")).toBe(true);
    expect(corePageNav.groups.flatMap((group) => group.items).some((item) => item.href === "/screener/")).toBe(true);

    // Off the core set there is no rail, so the sidebar lists everything.
    const nonCorePageNav = getSidebarNavForPath("/stablecoin/usdt-tether/");
    expect(nonCorePageNav.primaryItems).toBe(PRIMARY_NAV_ITEMS);
    expect(nonCorePageNav.groups).toBe(NAV_GROUPS);
  });

  it("exposes PharosVille as an external companion entry, not a primary or group route", () => {
    expect(COMPANION_NAV_ITEMS).toHaveLength(1);
    const ville = COMPANION_NAV_ITEMS[0];
    expect(ville.label).toBe("PharosVille");
    expect(ville.external).toBe(true);
    expect(ville.href.startsWith("https://")).toBe(true);
    expect(PRIMARY_NAV_ITEMS.some((item) => item.label === "PharosVille")).toBe(false);
    expect(NAV_GROUPS.flatMap((g) => g.items).some((item) => item.label === "PharosVille")).toBe(false);
    expect(NAV_ITEMS.some((item) => item.label === "PharosVille")).toBe(true);
  });
});
