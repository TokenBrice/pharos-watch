import { describe, expect, it } from "vitest";
import { NAV_GROUPS, PRIMARY_NAV_ITEMS } from "@/lib/nav-config";

describe("nav-config", () => {
  it("promotes dashboard and Pharos core features to the primary nav block in the intended order", () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/",
      "/stability-index",
      "/safety-scores",
      "/yield",
    ]);

    // Telegram moved out of the primary block; it lives in the TRACK data
    // group, while Digest and Status now live in the separate MONITOR group.
    expect(PRIMARY_NAV_ITEMS.find((item) => item.href === "/telegram")).toBeUndefined();
    const dataGroup = NAV_GROUPS.find((group) => group.key === "data");
    const monitorGroup = NAV_GROUPS.find((group) => group.key === "monitor");
    expect(dataGroup?.items.some((item) => item.href === "/telegram")).toBe(false);
    expect(monitorGroup?.items.some((item) => item.href === "/telegram")).toBe(true);
  });

  it("orders the sidebar groups and routes as requested while excluding legacy Risk Lab grouping", () => {
    expect(NAV_GROUPS.some((group) => group.key === "risk-lab")).toBe(false);
    expect(NAV_GROUPS.map((group) => group.key)).toEqual(["data", "tools", "monitor", "info"]);

    const trackGroup = NAV_GROUPS.find((group) => group.key === "data");
    const analyzeGroup = NAV_GROUPS.find((group) => group.key === "tools");
    const monitorGroup = NAV_GROUPS.find((group) => group.key === "monitor");
    const infoGroup = NAV_GROUPS.find((group) => group.key === "info");

    expect(trackGroup?.label).toBe("TRACK");
    expect(trackGroup?.items.map((item) => item.label)).toEqual([
      "Liquidity",
      "Depeg",
      "Mint/Burn Flows",
      "Blacklist",
      "Chains",
      "Cemetery",
    ]);

    expect(analyzeGroup?.label).toBe("ANALYZE");
    expect(analyzeGroup?.items.map((item) => item.href)).toEqual([
      "/dependency-map",
      "/portfolio",
      "/compare",
    ]);

    expect(monitorGroup?.label).toBe("MONITOR");
    expect(monitorGroup?.items.map((item) => ({ href: item.href, label: item.label }))).toEqual([
      { href: "/telegram", label: "Telegram" },
      { href: "/upcoming", label: "Upcoming" },
      { href: "/digest", label: "Digest" },
      { href: "/status", label: "Pharos Status" },
    ]);

    expect(infoGroup?.label).toBe("REFERENCE");
    expect(infoGroup?.items.some((item) => item.href === "/digest")).toBe(false);
    expect(infoGroup?.items.some((item) => item.href === "/status")).toBe(false);
    expect(infoGroup?.items.map((item) => item.href)).toEqual([
      "/about",
      "/funding",
      "/methodology",
      "/coverage",
      "/about/api",
      "/changelog",
    ]);
  });
});
