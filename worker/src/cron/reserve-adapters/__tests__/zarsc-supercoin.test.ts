import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptAttestationPdfIndex } from "../attestation-pdf-index";

const INDEX_URL = "https://www.supercoin.co.za/assurance-reports";
const REPORT_URL = "https://cdn.prod.website-files.com/6a46ac9899c74f98e01a0974/6aab8e272c83908780b26065_ZARSC%20AUG%202026%20Stablecoin%20Attestation%2031082026%20FINAL.pdf";
const html = readFileSync(new URL("./fixtures/zarsc-supercoin.html", import.meta.url), "utf8");
const params = {
  slices: [{ name: "ZAR cash in Absa current account", pct: 100, risk: "low" as const, assetClass: "bank-deposit" as const, issuerOrObligor: "Absa Bank Limited" }],
  reviewedReport: { url: REPORT_URL, balanceDate: "2026-08-31" },
};

describe("Supercoin reviewed report index", () => {
  it("dates the actual August balances rather than the signature or capture", () => {
    const result = adaptAttestationPdfIndex(html, params, { indexUrl: INDEX_URL });
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Date.parse("2026-08-31T00:00:00Z") / 1000,
      freshnessMode: "verified", reportPdfUrl: REPORT_URL,
      compositionSource: "configured-static-slices",
    });
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
  });

  it("withholds the old balance clock when the index publishes a newer unreviewed PDF", () => {
    const nextReport = "https://cdn.prod.website-files.com/6a46ac9899c74f98e01a0974/new_ZARSC%20SEP%202026%20Stablecoin%20Attestation%2030092026.pdf";
    const changed = html.replace(REPORT_URL, nextReport);
    const result = adaptAttestationPdfIndex(changed, params, { indexUrl: INDEX_URL });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "attestation-report-basis-unreviewed", effect: "degraded" }));
  });
});
