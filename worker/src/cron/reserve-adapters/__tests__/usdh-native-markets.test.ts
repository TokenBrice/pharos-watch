import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptUsdhNativeMarkets } from "../usdh-native-markets";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "usdh-native-markets.html"), "utf8");

describe("adaptUsdhNativeMarkets", () => {
  it("emits a single reviewed-attestation slice at risk low", () => {
    const result = adaptUsdhNativeMarkets(SAMPLE_HTML);
    expect(result.slices).toEqual([
      {
        name: "Reviewed attestation reserves (cash / T-Bills / custody)",
        pct: 100,
        risk: "low",
      },
    ]);
  });

  it("picks the latest attestation link by (year, month) and derives end-of-month timestamp", () => {
    const result = adaptUsdhNativeMarkets(SAMPLE_HTML);
    // Fixture has January + February 2026 → latest = 2026_february.pdf → Feb 28, 2026
    expect(result.metadata).toMatchObject({
      attestationPeriod: "February 2026",
      attestationPdfPath: "/attestations/2026_february.pdf",
      sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
      freshnessMode: "verified",
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: Date.UTC(2026, 1, 28) / 1000,
        routeStatus: "unknown",
        holderEligibility: "verified-customer",
      },
    });
  });

  it("throws layout-changed when no /attestations/YYYY_<month>.pdf link is present", () => {
    const emptyHtml = "<html><body><p>No attestations published yet.</p></body></html>";
    expect(() => adaptUsdhNativeMarkets(emptyHtml)).toThrow("layout-changed");
  });

  it("prefers the greater month when multiple entries share the latest year", () => {
    const html = `
      <a href="/attestations/2026_february.pdf">View</a>
      <a href="/attestations/2026_january.pdf">View</a>
      <a href="/attestations/2025_december.pdf">View</a>
    `;
    const result = adaptUsdhNativeMarkets(html);
    expect(result.metadata?.attestationPeriod).toBe("February 2026");
    expect(result.metadata?.attestationPdfPath).toBe("/attestations/2026_february.pdf");
  });

  it("prefers the greater year even when a later month exists in an earlier year", () => {
    const html = `
      <a href="/attestations/2026_january.pdf">View</a>
      <a href="/attestations/2025_december.pdf">View</a>
    `;
    const result = adaptUsdhNativeMarkets(html);
    expect(result.metadata?.attestationPeriod).toBe("January 2026");
  });
});
