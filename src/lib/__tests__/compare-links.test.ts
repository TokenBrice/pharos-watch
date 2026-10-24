import { describe, expect, it } from "vitest";
import {
  buildComparePrefillUrl,
  buildStaticCompareHref,
  getPrimaryStaticComparisonLinkForCoin,
  parseComparePrefillHash,
} from "../compare-links";

describe("static compare links", () => {
  it("links a coin's curated pair, or prefills the picker through a fragment, never a ?coins= facet", () => {
    expect(buildStaticCompareHref(["usdg-paxos"])).toBe("/compare/usdc-circle-vs-usdg-paxos/");
    expect(buildStaticCompareHref(["unknown-coin"])).toBe("/compare/#coins=unknown-coin");
    expect(buildStaticCompareHref(["unknown-coin"])).not.toContain("?");
  });

  it("links two coins' curated pair in either order, and prefills anything else", () => {
    expect(buildStaticCompareHref(["usdc-circle", "usdt-tether"])).toBe("/compare/usdt-tether-vs-usdc-circle/");
    expect(buildStaticCompareHref(["usdt-tether", "usdc-circle", "usde-ethena"])).toBe(
      "/compare/#coins=usdt-tether,usdc-circle,usde-ethena",
    );
  });

  it("round-trips the prefill fragment and ignores other hashes", () => {
    const url = buildComparePrefillUrl(["usdt-tether", "usdc-circle"]);
    expect(parseComparePrefillHash(url.slice(url.indexOf("#")))).toEqual(["usdt-tether", "usdc-circle"]);
    expect(parseComparePrefillHash("#faq")).toBeNull();
    expect(parseComparePrefillHash("#coins=")).toBeNull();
    expect(parseComparePrefillHash("#coins=%E0%A4%A,usdc-circle")).toEqual(["usdc-circle"]);
  });
});

describe("primary profile comparison", () => {
  it.each([
    ["usde-ethena", "usde-ethena-vs-susde-ethena", "sUSDe"],
    ["susde-ethena", "usde-ethena-vs-susde-ethena", "USDe"],
    ["usdg-paxos", "usdc-circle-vs-usdg-paxos", "USDC"],
    ["paxg-paxos", "paxg-paxos-vs-xaut-tether", "XAUT"],
    ["usdc-circle", "usdt-tether-vs-usdc-circle", "USDT"],
  ])("links %s to the relevant existing brief", (coinId, slug, benchmarkSymbol) => {
    expect(getPrimaryStaticComparisonLinkForCoin(coinId)).toEqual({
      href: `/compare/${slug}/`,
      benchmarkSymbol,
    });
  });

  it("leaves coins without a brief to the caller's live-tool fallback", () => {
    expect(getPrimaryStaticComparisonLinkForCoin("unknown-coin")).toBeNull();
  });
});
