import { afterEach, describe, expect, it, vi } from "vitest";
import { getIndependentAssuranceManifest, IndependentAssuranceManifestSchema, reconcileIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { AGORA_INDEPENDENT_ASSURANCE_PROFILE } from "../agora-independent-assurance-profile";
import { collectPdfAnchors } from "../helpers";
import { indexFixture, verifyFixtureIndex } from "./independent-assurance.test-support";

const manifest = getIndependentAssuranceManifest("AUSD");
const profile = AGORA_INDEPENDENT_ASSURANCE_PROFILE;
const prepare = profile.prepareIndexHtml!;
const fixture = "agora-transparency-2026-09-30-august.html";
const fern = `/_fern-files${new URL(manifest.reportUrl).pathname}`;
const anchor = (href: string) => `<a href="${href}">2026 Aug - Agora Dollar Reserve Report</a>`;

afterEach(() => vi.unstubAllGlobals());

describe("Agora reviewed August examination", () => {
  it("parses Fern dates across report naming conventions", () => {
    const date = profile.reportDateFromCandidate!;
    expect(date("https://x/2026%20Jul%20-%20Agora%20Dollar%20Reserve%20Report.pdf", "2026 Jul - Agora Dollar Reserve Report")).toBe("2026-07-31");
    expect(date("https://x/2026%20Jun%20-%20Agora%20Dollar%20Reserve%20Report.pdf", "")).toBe("2026-06-30");
    expect(date("https://x/Management%20Report%20on%20Agora%20Dollar%20and%20Reserve%20Assets%20as%20of%2012.31.25.pdf", "")).toBe("2025-12-31");
    expect(date("https://x/other.pdf", "")).toBeNull();
  });

  it("rewrites the signed reviewed report while keeping older transport links", async () => {
    const signed = manifest.reportUrl.replace("files.buildwithfern.com", "fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com") + "?X-Amz-Signature=abcd";
    const june = "https://fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com/agora.docs.buildwithfern.com/a7e3e708ecba5f1826066cb1ba633eb231ceb1765bb76a54cb6994be07eaf34c/docs/assets/2026%20Jun%20-%20Agora%20Dollar%20Reserve%20Report.pdf?X-Amz-Signature=efgh";
    const may = "https://files.buildwithfern.com/agora.docs.buildwithfern.com/938a11767a399cc2cfd2a15efc4cdfab65a53e59402e61c9e166b5354b5c9673/docs/assets/2026%20May%20-%20Agora%20Dollar%20Reserve%20Report.pdf";
    const prepared = await prepare([signed, june, may].map(href => `<a href="${href}">report</a>`).join("\n"), new AbortController().signal);
    expect(collectPdfAnchors(prepared)).toEqual([
      { href: manifest.reportUrl, text: "report" },
      { href: june, text: "report" },
      { href: may, text: "report" },
    ]);
  });

  it("accepts a single already-stable reviewed link", async () => {
    const prepared = await prepare(anchor(manifest.reportUrl), new AbortController().signal);
    expect(collectPdfAnchors(prepared)).toEqual([{ href: manifest.reportUrl, text: "2026 Aug - Agora Dollar Reserve Report" }]);
  });

  it("dates every report candidate in the current official capture", async () => {
    const prepared = await prepare(indexFixture(fixture), new AbortController().signal);
    const reports = collectPdfAnchors(prepared).filter(a => /\.pdf(?:[?#]|$)/i.test(a.href) && profile.isReportCandidate(a.href, a.text));
    expect(reports.every(a => profile.reportDateFromCandidate!(a.href, a.text) !== null)).toBe(true);
  });

  it("fails closed on the frozen July index because the August reviewed link is missing", async () => {
    await expect(prepare(indexFixture("agora-transparency-2026-09-30.html"), new AbortController().signal))
      .rejects.toThrow("reviewed report link missing or ambiguous");
  });

  it("binds the official Fern index to the reviewed stable artifact", async () => {
    const prepared = await prepare(indexFixture(fixture), new AbortController().signal);
    expect(collectPdfAnchors(prepared).filter(a => a.href === manifest.reportUrl)).toEqual([
      { href: manifest.reportUrl, text: "2026 Aug - Agora Dollar Reserve Report" },
    ]);
    const signed = manifest.reportUrl.replace("files.buildwithfern.com", "fdr-prod-docs-files-public.s3.us-east-1.amazonaws.com") + "?X-Amz-Signature=abcd";
    expect(await prepare(anchor(signed), new AbortController().signal)).toContain(`href="${manifest.reportUrl}"`);
  });

  it.each([
    "", anchor(fern) + anchor(manifest.reportUrl),
    anchor(manifest.reportUrl.replace("files.buildwithfern.com", "example.com")),
    anchor(fern.replace("444c4f3a", "00000000")),
  ])("fails closed on missing, duplicated or drifted reviewed identity", async html => {
    await expect(prepare(html, new AbortController().signal)).rejects.toThrow("reviewed report link missing or ambiguous");
  });

  it("fails closed on a newer report and undated candidates", async () => {
    await expect(verifyFixtureIndex("AUSD", profile, fixture, indexFixture(fixture) + anchor("https://files.buildwithfern.com/2026%20Sep%20Agora%20Dollar%20Reserve%20Report.pdf"))).rejects.toThrow("newer unreviewed report");
    await expect(verifyFixtureIndex("AUSD", profile, fixture, indexFixture(fixture) + '<a href="/Agora%20Dollar%20Reserve%20Report.pdf">Report</a>')).rejects.toThrow("ambiguous report date");
  });

  it("preserves measured categories and excludes created supply without asset netting", () => {
    expect(reconcileIndependentAssuranceManifest(manifest, profile.reconciliation)).toMatchObject({
      computedAssetTotal: "239090455", liabilityTotal: "238379206", reportedAssetDifference: "1",
    });
    expect(manifest.adjustments).toEqual([expect.objectContaining({ kind: "excluded-circulation", amount: "28141214" })]);
    expect(manifest.adjustments![0]).not.toHaveProperty("alreadyNettedIntoAssets");
    expect(() => reconcileIndependentAssuranceManifest({ ...manifest, reportedAssetTotal: "239090457" }, profile.reconciliation)).toThrow("reported asset total");
  });

  it("requires netted asset adjustments to declare their accounting treatment", () => {
    const adjustment = { code: "net-cash", label: "Net cash", amount: "-1", treatment: "Already deducted from asset row" };
    expect(IndependentAssuranceManifestSchema.safeParse({ ...manifest, adjustments: [adjustment] }).success).toBe(false);
    expect(IndependentAssuranceManifestSchema.safeParse({ ...manifest, adjustments: [{ ...adjustment, alreadyNettedIntoAssets: true }] }).success).toBe(true);
    expect(IndependentAssuranceManifestSchema.safeParse({ ...manifest, adjustments: [{ ...adjustment, kind: "excluded-circulation" }] }).success).toBe(true);
  });
});
