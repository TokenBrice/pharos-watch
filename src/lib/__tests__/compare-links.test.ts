import { describe, expect, it } from "vitest";
import { getPrimaryStaticComparisonLinkForCoin } from "../compare-links";

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
