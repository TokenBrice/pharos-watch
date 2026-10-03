import { describe, expect, it } from "vitest";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { parseJpmorganNav } from "../jpmorgan-nav";

const dealingAt = Date.parse("2026-10-01T00:00:00Z") / 1000;
const publisher = `# Product Facts - JPMorgan OnChain Liquidity-Token Money Market Fund
- **Fund Name**: JPMorgan OnChain Liquidity-Token Money Market Fund
- **Share Class Name**: JPMorgan OnChain Liquidity-Token Money Market Fund-Token Class
- **Ticker**: JLTXX
- **CUSIP**: 46655R119
- **Share Class Number**: 4397
- **Transaction NAV As of 10/01/2026**: $1.00
- **Share Class Assets As of 10/01/2026**: $626.64mn
`;

describe("JPMorgan exact-class NAV publisher", () => {
  it("keeps issuer class assets diagnostic and uses the dealing date rather than the render clock", () => {
    const result = parseJpmorganNav(publisher + "> Generated: 2026-10-02T22:42:44Z.\n", dealingAt + 86400);
    expect(result.metadata).toMatchObject({ navPerToken: 1, sourceTimestamp: dealingAt, freshnessMode: "verified", details: { classAssetsUsd: 626_640_000, dealingDate: "2026-10-01" } });
    expect(result.metadata).not.toHaveProperty("supplyTokens");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it("observes changed NAV rather than substituting the fund's dollar target", () => {
    const result = parseJpmorganNav(publisher.replace("$1.00", "$0.9973").replace("$626.64mn", "$1.23bn"), dealingAt + 86400);
    expect(result.metadata).toMatchObject({ navPerToken: 0.9973, details: { classAssetsUsd: 1_230_000_000 } });
  });

  it.each([
    ["46655R119", "46655R127"], ["4397", "4398"], ["JLTXX", "MONY"],
    ["-Token Class", "-Other Class"],
    ["**Share Class Assets As of 10/01/2026**", "**Share Class Assets As of 09/30/2026**"],
    ["$1.00", "$0.00"], ["$626.64mn", "$0mn"], ["$626.64mn", "$626.64mm"],
    ["10/01/2026", "02/30/2026"],
  ])("fails closed on identity, accounting or schema drift (%s)", (from, to) => {
    expect(() => parseJpmorganNav(publisher.replaceAll(from, to), dealingAt + 86400)).toThrow(/jpmorgan-nav/);
  });

  it("rejects conflicting identity and duplicate NAV rows", () => {
    expect(() => parseJpmorganNav(publisher + "- **CUSIP**: 46655R127\n", dealingAt)).toThrow(/conflicting/);
    expect(() => parseJpmorganNav(publisher + "- **Transaction NAV As of 10/01/2026**: $1.00\n", dealingAt)).toThrow(/duplicate/);
  });

  it("allows the reviewed weekend/holiday window but rejects its first stale second and future dates", () => {
    expect(parseJpmorganNav(publisher, dealingAt + 3 * 86400).metadata?.navPerToken).toBe(1);
    expect(parseJpmorganNav(publisher, dealingAt + BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC).metadata?.navPerToken).toBe(1);
    expect(() => parseJpmorganNav(publisher, dealingAt + BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC + 1)).toThrow(/stale/);
    expect(() => parseJpmorganNav(publisher, dealingAt - 1)).toThrow(/future/);
  });
});
