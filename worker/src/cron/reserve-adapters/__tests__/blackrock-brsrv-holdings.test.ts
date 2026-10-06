import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBlackrockBrsrvHoldings } from "../blackrock-brsrv-holdings";
const body = readFileSync(new URL("./fixtures/blackrock-brsrv-holdings.txt", import.meta.url), "utf8")
  .replace(/<!--[^]*?-->\r?\n/g, "");
const now = Date.parse("2026-10-03T07:00:00Z") / 1000;
describe("BlackRock BRSRV disclosed securities", () => {
  it("weights securities by measured market value, not par percentages", () => {
    const result = parseBlackrockBrsrvHoldings(body, now);
    const repo = result.slices.find((r) => r.sourceKey?.endsWith("treasury-repo"))!;
    expect(repo.pct).toBeCloseTo(9_000_000 / 49_853_218.07 * 100, 6);
    expect(result.metadata).toMatchObject({ sourceTimestamp: Date.parse("2026-10-01T00:00:00Z") / 1000 });
    expect(result.metadata).not.toHaveProperty("totalReservesUsd");
    expect(result.metadata).not.toHaveProperty("immediateRedeemableUsd");
  });
  it("preserves unreviewed categories as high-risk unknown exposure", () => {
    const result = parseBlackrockBrsrvHoldings(body.replaceAll("U.S. Treasury Debt", "Unreviewed security"), now);
    expect(result.slices.find((r) => r.name.includes("Unreviewed security"))?.risk).toBe("high");
    expect(result.metadata?.unknownExposurePct).toBeGreaterThan(80);
  });
  it("rejects truncated, negative and malformed values rather than dropping rows", () => {
    expect(() => parseBlackrockBrsrvHoldings(body.replace('"5,000,000.00"', '"-5,000,000.00"').replace('"5,000,000.00"', '"-5,000,000.00"'), now)).toThrow();
    expect(() => parseBlackrockBrsrvHoldings(body.split("\n").slice(0, 5).join("\n"), now)).toThrow(/incomplete/);
    expect(() => parseBlackrockBrsrvHoldings(body.replace('"4,996,858.33"', '"4,99,858.33"'), now)).toThrow();
  });
  it("rejects stale or invalid holding dates", () => {
    expect(() => parseBlackrockBrsrvHoldings(body, now + 6 * 86400)).toThrow(/stale/);
    expect(() => parseBlackrockBrsrvHoldings(body.replace("01-Oct-2026", "30-Feb-2026"), now)).toThrow(/invalid/);
  });
  it("does not refresh an October 1 disclosure merely because it was fetched on October 6", () => {
    const sourceTimestamp = Date.parse("2026-10-01T00:00:00Z") / 1000;
    expect(() => parseBlackrockBrsrvHoldings(body, sourceTimestamp + 5 * 86400)).not.toThrow();
    expect(() => parseBlackrockBrsrvHoldings(body, sourceTimestamp + 5 * 86400 + 1)).toThrow(/stale/);
    expect(() => parseBlackrockBrsrvHoldings(body, 1791272210)).toThrow(/stale/);
  });
});
