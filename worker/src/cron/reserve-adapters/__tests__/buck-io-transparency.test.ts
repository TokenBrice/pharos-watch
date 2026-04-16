import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptBuckIoTransparency } from "../buck-io-transparency";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "buck-io.html"), "utf8");

describe("adaptBuckIoTransparency", () => {
  it("maps the reserve ledger into USDC + STRC slices summing to 100%", () => {
    const result = adaptBuckIoTransparency(SAMPLE_HTML);
    // USDC $150.00K (23.08%) + STRC $500.00K (76.92%) of $650.00K total
    expect(result.slices).toEqual([
      {
        name: "Strategy Inc. perpetual preferred stock (STRC, BTC-backed)",
        pct: 76.9,
        risk: "medium",
      },
      {
        name: "USDC liquidity reserve",
        pct: 23.1,
        risk: "low",
        coinId: "usdc-circle",
      },
    ]);
    const total = result.slices.reduce((acc, s) => acc + s.pct, 0);
    expect(total).toBeCloseTo(100, 5);
  });

  it("extracts the 'Last updated' timestamp as verified freshness", () => {
    const result = adaptBuckIoTransparency(SAMPLE_HTML);
    expect(result.metadata).toMatchObject({
      sliceCount: 2,
      lastUpdated: "Apr 9, 2026",
      sourceTimestamp: Date.UTC(2026, 3, 9) / 1000,
      freshnessMode: "verified",
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: Date.UTC(2026, 3, 9) / 1000,
        routeStatus: "unknown",
        holderEligibility: "verified-customer",
      },
    });
  });

  it("throws layout-changed when USDC in reserves is missing", () => {
    const brokenHtml = SAMPLE_HTML.replace("USDC in reserves", "USDC in vault");
    expect(() => adaptBuckIoTransparency(brokenHtml)).toThrow("layout-changed");
  });

  it("throws layout-changed when STRC in reserves is missing", () => {
    const brokenHtml = SAMPLE_HTML.replace("STRC in reserves", "STRC in vault");
    expect(() => adaptBuckIoTransparency(brokenHtml)).toThrow("layout-changed");
  });

  it("falls back to unverified freshness when 'Last updated' is missing", () => {
    const htmlNoDate = SAMPLE_HTML.replace("Last updated", "Updated recently");
    const result = adaptBuckIoTransparency(htmlNoDate);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      freshnessKind: "unverified",
    });
  });
});
